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
export async function walkClaudeWorkflows(opts: { projectsDir?: string } = {}): Promise<ClaudeWorkflowEntry[]> {
  const projectsDir = opts.projectsDir ?? path.join(os.homedir(), ".claude", "projects");

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

  await Promise.all(
    projectDirs.map(async (projectDirName) => {
      const projectPath = path.join(projectsDir, projectDirName);
      let sessionDirs: string[];
      try {
        sessionDirs = (await fs.readdir(projectPath, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return;
      }
      await Promise.all(
        sessionDirs.map(async (sessionId) => {
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
        })
      );
    })
  );

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
      if (at && bt) return bt.localeCompare(at);
      if (at) return -1;
      if (bt) return 1;
      return 0;
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

  // Two different scripts can declare the same `meta.name` (a workflow renamed
  // between runs, say). Merge them so the catalog holds one row per id, rather
  // than two rows that look like duplicates.
  const byId = new Map<string, ClaudeWorkflowEntry>();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (!existing) { byId.set(e.id, e); continue; }
    existing.runs = [...existing.runs, ...e.runs];
    existing.runCount += e.runCount;
    existing.projectDirNames = [...new Set([...existing.projectDirNames, ...e.projectDirNames])].sort();
    if (e.lastRunAt && (!existing.lastRunAt || e.lastRunAt > existing.lastRunAt)) {
      existing.lastRunAt = e.lastRunAt;
      existing.scriptExcerpt = e.scriptExcerpt;
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.lastRunAt && b.lastRunAt) return b.lastRunAt.localeCompare(a.lastRunAt);
    if (a.lastRunAt) return -1;
    if (b.lastRunAt) return 1;
    return a.name.localeCompare(b.name);
  });
}
