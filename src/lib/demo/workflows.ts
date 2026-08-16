import type { ClaudeWorkflowEntry, ClaudeWorkflowRun } from "@/lib/indexer/walkWorkflows";

/**
 * Synthetic Claude Code workflow catalog for demo mode (#441).
 *
 * `/api/workflows` and `/api/workflows/[id]` both walked the real
 * `~/.claude/projects/**\/workflows/` tree with no demo guard, so the catalog
 * published the user's actual workflow names, run counts, session ids and
 * absolute script paths. Returned from a guard on `walkClaudeWorkflows()`
 * itself — the loader both routes share — rather than from each route, so the
 * seam stays closed if a third caller appears.
 *
 * Deterministic: run ids and phases are fixed, and only the run timestamps are
 * anchored to `nowMs`, matching the session fixtures' "fresh relative times,
 * byte-stable structure" rule.
 */
interface WorkflowSeed {
  name: string;
  description: string;
  whenToUse?: string;
  phases: { title: string; detail?: string }[];
  /** Encoded project dirs (`C--dev-<slug>`) this workflow has run in. */
  projects: string[];
  /** Hours-ago offset per run, newest first. */
  runOffsetsHours: number[];
  script: string;
}

const SEEDS: WorkflowSeed[] = [
  {
    name: "review-changes",
    description: "Review changed files across dimensions, then verify each finding adversarially",
    whenToUse: "Before merging a branch that touches more than a couple of modules.",
    phases: [
      { title: "Review", detail: "one agent per review dimension" },
      { title: "Verify", detail: "refute each finding independently" },
    ],
    projects: ["C--dev-aurora-commerce", "C--dev-ledger-api"],
    runOffsetsHours: [3, 27, 51, 99, 123, 171],
    script: "const DIMENSIONS = [{key: 'bugs'}, {key: 'perf'}, {key: 'security'}]\nconst results = await pipeline(DIMENSIONS, d => agent(d.prompt), r => verify(r))\n",
  },
  {
    name: "find-flaky-tests",
    description: "Scan CI logs for retry markers and propose a fix per flaky test",
    whenToUse: "When the suite passes on re-run more often than it should.",
    phases: [
      { title: "Scan", detail: "grep test logs for retries" },
      { title: "Fix", detail: "one agent per flaky test" },
    ],
    projects: ["C--dev-pulse-analytics"],
    runOffsetsHours: [14, 62, 158],
    script: "phase('Scan')\nconst flaky = await agent('grep CI logs for retry markers', {schema: FLAKY})\n",
  },
  {
    name: "migrate-imports",
    description: "Discover every call site, transform each in isolation, then verify the tree builds",
    whenToUse: "Codemod-style migrations too wide for one context.",
    phases: [
      { title: "Discover" },
      { title: "Transform", detail: "worktree-isolated, one per file" },
      { title: "Verify" },
    ],
    projects: ["C--dev-quill-cms", "C--dev-atlas-cli", "C--dev-archive-legacy-dash"],
    runOffsetsHours: [40, 220],
    script: "const sites = await agent('list every import of the legacy helper', {schema: SITES})\nawait pipeline(sites.files, f => agent(`rewrite ${f}`, {isolation: 'worktree'}))\n",
  },
  {
    name: "research-sweep",
    description: "Multi-modal search sweep, deep-read the best sources, synthesize one answer",
    projects: ["C--dev-beacon-mobile"],
    phases: [{ title: "Sweep" }, { title: "Read" }, { title: "Synthesize" }],
    runOffsetsHours: [8],
    script: "const modes = ['by-container', 'by-content', 'by-entity', 'by-time']\nconst hits = await parallel(modes.map(m => () => agent(`search ${m}`)))\n",
  },
];

const HOUR = 3_600_000;

export function demoWorkflows(nowMs: number): ClaudeWorkflowEntry[] {
  return SEEDS.map((seed) => {
    const runs: ClaudeWorkflowRun[] = seed.runOffsetsHours.map((h, i) => {
      const project = seed.projects[i % seed.projects.length];
      const runId = `wf_${seed.name.replace(/-/g, "")}${String(i + 1).padStart(2, "0")}`;
      const sessionId = `demo-${seed.name}-${i + 1}`;
      return {
        runId,
        timestamp: new Date(nowMs - h * HOUR).toISOString(),
        taskId: i % 3 === 0 ? `task-${100 + i}` : undefined,
        // Synthetic path under the same shape the real walker produces, so the
        // detail view renders a realistic (and obviously fake) location.
        scriptPath: `C:\\Users\\demo\\.claude\\projects\\${project}\\${sessionId}\\workflows\\scripts\\${seed.name}-${runId}.js`,
        projectDirName: project,
        sessionId,
      };
    });

    return {
      id: `workflow:${seed.name}`,
      name: seed.name,
      description: seed.description,
      whenToUse: seed.whenToUse,
      phases: seed.phases,
      runs,
      runCount: runs.length,
      lastRunAt: runs[0]?.timestamp,
      projectDirNames: [...new Set(seed.projects)],
      scriptExcerpt: seed.script,
      fileBytes: seed.script.length,
    };
  });
}
