import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseWorkflowMeta, type WorkflowPhase } from "./parseWorkflowMeta";

/**
 * C1 — catalog of Claude Code `Workflow` scripts.
 *
 * **The plan had the location wrong.** It specified `.claude/workflows/`,
 * mirroring the skills and commands walkers. No such directory exists — not at
 * user level, not in any project. The Workflow tool persists per *session*:
 *
 *     ~/.claude/projects/<encoded-project>/<session-id>/workflows/
 *         scripts/<name>-<runId>.js   the script, with `export const meta`
 *         wf_<runId>.json             run record: { runId, timestamp, taskId, script }
 *
 * That difference is not cosmetic. A session-scoped location means the same
 * workflow appears once per run, so the catalog has to fold runs into one entry
 * per script name and treat run count and last-run as first-class — which is
 * also what makes it useful, since "the code-review workflow ran 12 times this
 * week" is the question a per-directory walker could never answer.
 *
 * Named `ClaudeWorkflowEntry`, deliberately: `src/lib/scanner/cicd.ts` already
 * uses "workflows" for GitHub Actions and the two must not blur.
 */
export interface ClaudeWorkflowRun {
  runId: string;
  /** ISO8601 from the run record. */
  timestamp?: string;
  taskId?: string;
  /** Absolute path to the persisted script for this run. */
  scriptPath: string;
  /** Project the run belongs to, from the encoded transcript directory. */
  projectDirName: string;
  sessionId: string;
}

export interface ClaudeWorkflowEntry {
  /** `workflow:<name>`; stable across runs so the catalog folds them. */
  id: string;
  /** `meta.name`, or the script's filename stem when meta could not be read. */
  name: string;
  description?: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
  /** Every persisted run of this workflow, newest first. */
  runs: ClaudeWorkflowRun[];
  runCount: number;
  /** Timestamp of the newest run, when any run record carried one. */
  lastRunAt?: string;
  /** Projects this workflow has run in, by encoded directory name. */
  projectDirNames: string[];
  /** Body of the most recent script, for the detail view. */
  scriptExcerpt: string;
  fileBytes: number;
  parseWarnings?: string[];
}

/** Newest first; `runId` breaks ties so the order is stable across walks. */
function sortRunsNewestFirst(a: ClaudeWorkflowRun, b: ClaudeWorkflowRun): number {
  if (a.timestamp && b.timestamp) {
    return b.timestamp.localeCompare(a.timestamp) || a.runId.localeCompare(b.runId);
  }
  if (a.timestamp) return -1;
  if (b.timestamp) return 1;
  return a.runId.localeCompare(b.runId);
}

/** `<name>-wf_<id>.js` → the run id, or null when the name doesn't match. */
function runIdFromScriptName(fileName: string): string | null {
  const m = /-(wf_[A-Za-z0-9-]+)\.js$/.exec(fileName);
  return m ? m[1] : null;
}

interface RunRecord {
  runId?: unknown;
  timestamp?: unknown;
  taskId?: unknown;
}

async function readRunRecords(workflowsDir: string): Promise<Map<string, RunRecord>> {
  const byRunId = new Map<string, RunRecord>();
  let names: string[];
  try {
    names = await fs.readdir(workflowsDir);
  } catch {
    return byRunId;
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith("wf_") && n.endsWith(".json"))
      .map(async (n) => {
        try {
          const raw = await fs.readFile(path.join(workflowsDir, n), "utf-8");
          const rec = JSON.parse(raw) as RunRecord;
          const id = typeof rec.runId === "string" ? rec.runId : n.replace(/\.json$/, "");
          byRunId.set(id, rec);
        } catch {
          // A truncated or half-written record is not worth failing the walk
          // for — the script file alone still yields a usable entry.
        }
      })
  );
  return byRunId;
}

/**
 * Walk every session's `workflows/scripts/` directory and fold runs by name.
 *
 * Reads the newest script per workflow for its meta and excerpt rather than all
 * of them: the scripts are near-identical across runs of the same workflow, and
 * on a corpus of thousands of sessions reading every copy would dominate the
 * walk for no extra information.
 */
export async function walkClaudeWorkflows(
  opts: { projectsDir?: string; projectsDirs?: string[] } = {}
): Promise<ClaudeWorkflowEntry[]> {
  // Every configured Claude home, not just the host's.
  //
  // `claudeHomes` exists so Minder on Windows can read Claude data out of a WSL
  // distro, and every other session consumer already honours it. This walker
  // defaulted to `os.homedir()` alone, so a workflow stored only in a configured
  // home was absent from both the list and the detail response — invisible
  // rather than degraded (Codex review, #389). Resolution goes through
  // `getReadableClaudeHomes`, which skips a home inside a stopped distro rather
  // than waking it: the never-wake invariant this repo holds elsewhere.
  const roots =
    opts.projectsDirs ??
    (opts.projectsDir
      ? [opts.projectsDir]
      : await (async () => {
          try {
            const { readConfig } = await import("@/lib/config");
            const { getReadableClaudeHomes } = await import("@/lib/claudeHome");
            const homes = await getReadableClaudeHomes(await readConfig());
            return homes.map((h) => path.join(h, "projects"));
          } catch {
            return [path.join(os.homedir(), ".claude", "projects")];
          }
        })());

  const all: ClaudeWorkflowEntry[] = [];
  for (const root of roots) {
    all.push(...(await walkOneProjectsDir(root)));
  }
  return foldWorkflowEntries(all);
}

/** Run `fn` over `items` in fixed-size waves, so fan-out stays bounded. */
async function batched<T>(items: T[], fn: (item: T) => Promise<void>, size = 8): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function walkOneProjectsDir(projectsDir: string): Promise<ClaudeWorkflowEntry[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  interface Found {
    run: ClaudeWorkflowRun;
    scriptName: string;
  }
  const found: Found[] = [];

  // Bounded fan-out at BOTH levels. An unbounded nested Promise.all over
  // projects x sessions can open thousands of concurrent readdir/readFile
  // handles on a large corpus and hit the OS fd limit (EMFILE). The other
  // indexers in this repo batch for the same reason (Copilot review of #389);
  // matching them also makes the walk order reproducible.
  const BATCH = 8;
  for (let i = 0; i < projectDirs.length; i += BATCH) {
    await Promise.all(
      projectDirs.slice(i, i + BATCH).map(async (projectDirName) => {
      const projectPath = path.join(projectsDir, projectDirName);
      let sessionDirs: string[];
      try {
        sessionDirs = (await fs.readdir(projectPath, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return;
      }
      // The inner walk is batched too. Bounding only the outer loop left this
      // `Promise.all` starting a filesystem walk for every session of a project
      // at once — and one encoded project holding thousands of session
      // directories is exactly the large-corpus case this walker exists for, so
      // the outer bound of 8 does not constrain the real fan-out at all
      // (Codex review, #389).
      await batched(sessionDirs, async (sessionId) => {
          const workflowsDir = path.join(projectPath, sessionId, "workflows");
          const scriptsDir = path.join(workflowsDir, "scripts");
          let scriptNames: string[];
          try {
            scriptNames = (await fs.readdir(scriptsDir)).filter((n) => n.endsWith(".js"));
          } catch {
            return;
          }
          if (scriptNames.length === 0) return;
          const records = await readRunRecords(workflowsDir);
          for (const scriptName of scriptNames) {
            const runId = runIdFromScriptName(scriptName) ?? scriptName.replace(/\.js$/, "");
            const rec = records.get(runId);
            found.push({
              scriptName,
              run: {
                runId,
                timestamp: typeof rec?.timestamp === "string" ? rec.timestamp : undefined,
                taskId: typeof rec?.taskId === "string" ? rec.taskId : undefined,
                scriptPath: path.join(scriptsDir, scriptName),
                projectDirName,
                sessionId,
              },
            });
          }
      });
      })
    );
  }

  if (found.length === 0) return [];

  // Fold by the script's filename stem first — the name in `meta` is what we
  // ultimately key on, but reading every script to learn it would defeat the
  // point of only reading the newest. The stem is `<name>-<runId>`, so stripping
  // the run id recovers the same grouping without opening a file.
  const byStem = new Map<string, Found[]>();
  for (const f of found) {
    const stem = f.scriptName.replace(/-wf_[A-Za-z0-9-]+\.js$/, "").replace(/\.js$/, "");
    const list = byStem.get(stem) ?? [];
    list.push(f);
    byStem.set(stem, list);
  }

  const entries: ClaudeWorkflowEntry[] = [];
  for (const [stem, runsForStem] of byStem) {
    // Newest first. A run with no timestamp sorts last rather than being
    // treated as epoch-zero, so a malformed record cannot become "the newest".
    runsForStem.sort((a, b) => {
      const at = a.run.timestamp, bt = b.run.timestamp;
      if (at && bt) return bt.localeCompare(at) || a.run.runId.localeCompare(b.run.runId);
      if (at) return -1;
      if (bt) return 1;
      // Both undated. Returning 0 left the order to whatever the parallel
      // directory walk happened to produce, which decides WHICH script is read
      // for meta and excerpt — so the same corpus could yield different catalog
      // text between runs (Copilot review of #389). runId is stable.
      return a.run.runId.localeCompare(b.run.runId);
    });

    const newest = runsForStem[0];
    let text = "";
    try {
      text = await fs.readFile(newest.run.scriptPath, "utf-8");
    } catch {
      // Script gone (session directory cleaned up) — still list the runs.
    }
    const meta = text ? parseWorkflowMeta(text) : { warnings: ["Script file unreadable"] };
    const name = meta.name || stem;

    entries.push({
      id: `workflow:${name}`,
      name,
      description: meta.description,
      whenToUse: meta.whenToUse,
      phases: meta.phases,
      runs: runsForStem.map((r) => r.run),
      runCount: runsForStem.length,
      lastRunAt: newest.run.timestamp,
      projectDirNames: [...new Set(runsForStem.map((r) => r.run.projectDirName))].sort(),
      scriptExcerpt: text.slice(0, 4000),
      fileBytes: Buffer.byteLength(text, "utf-8"),
      parseWarnings: meta.warnings.length > 0 ? meta.warnings : undefined,
    });
  }

  return entries;
}

/**
 * Merge entries that share an id into one catalog row.
 *
 * Two different scripts can declare the same `meta.name` (a workflow renamed
 * between runs, say), and with several Claude homes the same workflow can also
 * arrive once per home. Both collapse here, so the catalog holds one row per id
 * rather than rows that look like duplicates.
 */
function foldWorkflowEntries(entries: ClaudeWorkflowEntry[]): ClaudeWorkflowEntry[] {
  const byId = new Map<string, ClaudeWorkflowEntry>();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (!existing) { byId.set(e.id, e); continue; }
    existing.runs = [...existing.runs, ...e.runs].sort(sortRunsNewestFirst);
    existing.runCount += e.runCount;
    existing.projectDirNames = [...new Set([...existing.projectDirNames, ...e.projectDirNames])].sort();
    if (e.lastRunAt && (!existing.lastRunAt || e.lastRunAt > existing.lastRunAt)) {
      // Take EVERY version-dependent field from the winner, not just the
      // excerpt. Updating `scriptExcerpt` alone paired the newest script with
      // whichever entry the parallel walk happened to insert first — so the
      // detail view could show a new script beside a stale description
      // (Codex + Copilot review of #389).
      existing.lastRunAt = e.lastRunAt;
      existing.scriptExcerpt = e.scriptExcerpt;
      existing.description = e.description;
      existing.whenToUse = e.whenToUse;
      existing.phases = e.phases;
      existing.fileBytes = e.fileBytes;
      existing.parseWarnings = e.parseWarnings;
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.lastRunAt && b.lastRunAt) return b.lastRunAt.localeCompare(a.lastRunAt);
    if (a.lastRunAt) return -1;
    if (b.lastRunAt) return 1;
    return a.name.localeCompare(b.name);
  });
}
