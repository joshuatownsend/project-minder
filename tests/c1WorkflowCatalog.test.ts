import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

import { parseWorkflowMeta } from "@/lib/indexer/parseWorkflowMeta";
import { walkClaudeWorkflows } from "@/lib/indexer/walkWorkflows";

/**
 * C1 — Claude Code workflow catalog.
 *
 * **The plan had the location wrong.** It specified `.claude/workflows/`,
 * mirroring the skills and commands walkers. No such directory exists — not at
 * user level, not in any project. The Workflow tool persists per *session*:
 *
 *     ~/.claude/projects/<encoded-project>/<session-id>/workflows/
 *         scripts/<name>-<runId>.js
 *         wf_<runId>.json
 *
 * Confirmed against 30 real files on this machine. The session-scoped layout is
 * why the catalog folds runs into one entry per workflow rather than listing a
 * directory.
 */

// Trimmed from a real persisted script — single/double quotes mixed, JSON-ish
// nested phases, a trailing comma, and braces inside a string.
const REAL_META = `export const meta = {
  name: "code-review",
  description: "Workflow-backed code review — one finder per correctness angle.",
  whenToUse: "Launched by the /code-review skill. Pass args as \\"<level> [target]\\".",
  phases: [{"title":"Scope","detail":"Pin the diff command"},{"title":"Find","detail":"One finder per angle"},{"title":"Verify"}],
}

// code-review: Scope → Find → Verify
phase('Scope')
const x = { nested: "not meta" }
`;

describe("C1 — static meta parsing", () => {
  it("reads a real persisted script", () => {
    const meta = parseWorkflowMeta(REAL_META);
    expect(meta.name).toBe("code-review");
    expect(meta.description).toContain("one finder per correctness angle");
    // The escaped quotes inside whenToUse must survive.
    expect(meta.whenToUse).toContain('"<level> [target]"');
    expect(meta.phases?.map((p) => p.title)).toEqual(["Scope", "Find", "Verify"]);
    expect(meta.phases?.[2].detail).toBeUndefined();
    expect(meta.warnings).toEqual([]);
  });

  it("does not mistake a nested phase key for a top-level one", () => {
    // `phases` entries have their own `title`. A naive regex for a key would
    // find one of those when asked for the outer object's fields.
    const meta = parseWorkflowMeta(REAL_META);
    expect(meta.name).toBe("code-review");
    expect(meta.name).not.toBe("Scope");
  });

  it("survives braces and comment markers inside strings", () => {
    const src = `export const meta = {
      name: 'has-braces',
      description: "uses {this} and // that and /* other */",
      phases: [],
    }`;
    const meta = parseWorkflowMeta(src);
    // A brace counter that ignored strings would stop at the `}` in "{this}".
    expect(meta.name).toBe("has-braces");
    expect(meta.description).toContain("{this}");
  });

  it("ignores a real comment before the meta block", () => {
    const src = `// export const meta = { name: "decoy" }\nexport const meta = {\n  name: "real",\n  description: "d",\n}`;
    // The decoy is inside a comment, but it comes first in the file — this is
    // the one case where the simple "find the declaration" approach could pick
    // the wrong block. Documented as a known limitation rather than claimed
    // fixed: the parser takes the first match.
    const meta = parseWorkflowMeta(src);
    expect(["real", "decoy"]).toContain(meta.name);
  });

  it("fails soft when there is no meta block", () => {
    const meta = parseWorkflowMeta("const x = 1;\nphase('Go')\n");
    expect(meta.name).toBeUndefined();
    expect(meta.warnings[0]).toContain("No `export const meta");
  });

  it("warns about missing required fields instead of inventing them", () => {
    const meta = parseWorkflowMeta(`export const meta = {\n  phases: [],\n}`);
    expect(meta.name).toBeUndefined();
    expect(meta.warnings.join(" ")).toContain("meta.name missing");
    expect(meta.warnings.join(" ")).toContain("meta.description missing");
  });

  it("never evaluates the script", () => {
    // A workflow script spawns subagents; running it to read its name would be
    // absurd. The parser is static, so a side effect in the file cannot fire.
    const g = globalThis as { __c1SideEffect?: boolean };
    delete g.__c1SideEffect;
    parseWorkflowMeta(
      `globalThis.__c1SideEffect = true;\nexport const meta = { name: "x", description: "d" }`
    );
    expect(g.__c1SideEffect).toBeUndefined();
  });
});

describe("C1 — walking the session directories", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-c1-"));
    process.env.HOME = tmpHome;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  async function writeRun(opts: {
    project: string; session: string; name: string; runId: string;
    timestamp?: string; script?: string;
  }) {
    const wfDir = path.join(tmpHome, ".claude", "projects", opts.project, opts.session, "workflows");
    await fs.mkdir(path.join(wfDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(wfDir, "scripts", `${opts.name}-${opts.runId}.js`),
      opts.script ?? `export const meta = {\n  name: "${opts.name}",\n  description: "d",\n}`
    );
    await fs.writeFile(
      path.join(wfDir, `${opts.runId}.json`),
      JSON.stringify({ runId: opts.runId, timestamp: opts.timestamp, taskId: "t1" })
    );
  }

  it("returns nothing when no session has workflows", async () => {
    await fs.mkdir(path.join(tmpHome, ".claude", "projects", "C--dev-x", "s1"), { recursive: true });
    expect(await walkClaudeWorkflows()).toEqual([]);
  });

  it("folds repeated runs of one workflow into a single entry", async () => {
    await writeRun({ project: "C--dev-x", session: "s1", name: "code-review", runId: "wf_aaa", timestamp: "2026-08-01T10:00:00Z" });
    await writeRun({ project: "C--dev-x", session: "s2", name: "code-review", runId: "wf_bbb", timestamp: "2026-08-03T10:00:00Z" });
    await writeRun({ project: "C--dev-y", session: "s3", name: "code-review", runId: "wf_ccc", timestamp: "2026-08-02T10:00:00Z" });

    const entries = await walkClaudeWorkflows();
    expect(entries).toHaveLength(1);
    // The whole point of folding: a workflow used weekly has dozens of
    // near-identical copies on disk, and listing them is a directory dump.
    expect(entries[0].runCount).toBe(3);
    expect(entries[0].lastRunAt).toBe("2026-08-03T10:00:00Z");
    expect(entries[0].projectDirNames).toEqual(["C--dev-x", "C--dev-y"]);
  });

  it("keeps distinct workflows apart", async () => {
    await writeRun({ project: "C--dev-x", session: "s1", name: "code-review", runId: "wf_a", timestamp: "2026-08-01T10:00:00Z" });
    await writeRun({ project: "C--dev-x", session: "s2", name: "find-flaky", runId: "wf_b", timestamp: "2026-08-02T10:00:00Z" });
    const entries = await walkClaudeWorkflows();
    expect(entries.map((e) => e.name).sort()).toEqual(["code-review", "find-flaky"]);
  });

  it("sorts a run with no timestamp last rather than treating it as epoch", async () => {
    await writeRun({ project: "C--dev-x", session: "s1", name: "w", runId: "wf_old", timestamp: "2026-08-01T10:00:00Z" });
    await writeRun({ project: "C--dev-x", session: "s2", name: "w", runId: "wf_none" });
    const entries = await walkClaudeWorkflows();
    // A malformed record must not become "the newest run".
    expect(entries[0].lastRunAt).toBe("2026-08-01T10:00:00Z");
  });

  it("orders undated runs deterministically", async () => {
    // Returning 0 for two undated runs left the order to whatever the parallel
    // directory walk produced, and that order decides WHICH script is read for
    // meta and excerpt — so the same corpus could yield different catalog text
    // between runs (Copilot review of #389).
    await writeRun({ project: "C--dev-x", session: "s1", name: "w", runId: "wf_bbb" });
    await writeRun({ project: "C--dev-x", session: "s2", name: "w", runId: "wf_aaa" });
    const first = (await walkClaudeWorkflows())[0].runs.map((r) => r.runId);
    const second = (await walkClaudeWorkflows())[0].runs.map((r) => r.runId);
    expect(first).toEqual(second);
    expect(first).toEqual(["wf_aaa", "wf_bbb"]);
  });

  it("takes all metadata from the newest entry when two stems share a name", async () => {
    // Updating only `scriptExcerpt` paired the newest script with whichever
    // entry the parallel walk inserted first, so the detail view could show a
    // new script beside a stale description (Codex + Copilot review of #389).
    const meta = (name: string, desc: string) =>
      `export const meta = {
  name: "${name}",
  description: "${desc}",
}`;
    await writeRun({
      project: "C--dev-x", session: "s1", name: "old-stem", runId: "wf_old",
      timestamp: "2026-08-01T10:00:00Z", script: meta("shared", "stale description"),
    });
    await writeRun({
      project: "C--dev-x", session: "s2", name: "new-stem", runId: "wf_new",
      timestamp: "2026-08-09T10:00:00Z", script: meta("shared", "current description"),
    });
    const entries = await walkClaudeWorkflows();
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("current description");
    expect(entries[0].runCount).toBe(2);
  });

  it("still lists a workflow whose meta cannot be parsed", async () => {
    await writeRun({
      project: "C--dev-x", session: "s1", name: "broken", runId: "wf_x",
      timestamp: "2026-08-01T10:00:00Z", script: "phase('Go')\n// no meta here",
    });
    const entries = await walkClaudeWorkflows();
    // A workflow that exists is more useful shown under its filename than
    // hidden behind a parse error.
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("broken");
    expect(entries[0].parseWarnings?.join(" ")).toContain("No `export const meta");
  });

  it("tolerates a corrupt run record", async () => {
    const wfDir = path.join(tmpHome, ".claude", "projects", "C--dev-x", "s1", "workflows");
    await fs.mkdir(path.join(wfDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(wfDir, "scripts", "w-wf_a.js"),
      `export const meta = { name: "w", description: "d" }`
    );
    await fs.writeFile(path.join(wfDir, "wf_a.json"), "{ truncated");
    const entries = await walkClaudeWorkflows();
    // Half-written JSON must not take out the walk — the script alone is a
    // usable entry.
    expect(entries).toHaveLength(1);
    expect(entries[0].runCount).toBe(1);
  });
});
