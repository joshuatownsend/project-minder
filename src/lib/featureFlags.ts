import type { FeatureFlagKey, MinderConfig } from "./types";

/** Ordered list of every flag. Drives the Settings UI section + the
 *  /api/config validator + this module's exhaustiveness. Keep in sync
 *  with the FeatureFlagKey union in types.ts. */
export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  "scanInsights",
  "scanTodos",
  "scanManualSteps",
  "scanClaudeSessions",
  "scanWorktrees",
  "scanDockerCompose",
  "manualStepsWatcher",
  "gitStatusCache",
  "usageAnalytics",
  "agentSkillIndexer",
  "devServerControl",
  "liveActivity",
  "taskDispatcher",
  "mcpSecurityScan",
  "gsdPlanning",
  "agentView",
  "claudeStatusAlerts",
  "configLint",
  "scanBoard",
  "scanOps",
  "githubActivity",
  "mcpHealth",
  "rscHydration",
  "serverActions",
  "liveEvents",
] as const;

/** Human-readable metadata for the Settings UI. Empty groups are fine —
 *  they render nothing. */
export interface FeatureFlagMeta {
  key: FeatureFlagKey;
  label: string;
  description: string;
  group: "passive" | "active";
  appliesAt: "scan" | "watcher" | "ui" | "ingest";
  /** True when the gate is wired in this codebase today. False = the toggle
   *  persists but no consumer reads it yet (later waves wire it). The
   *  Settings UI shows a hint for unwired flags. */
  wired: boolean;
  /** The flag's effective default when its key is absent from config. Omitted
   *  ⇒ ON (the historical default for every flag). Set explicitly to `false`
   *  for opt-in flags whose server gate reads `getFlag(..., false)`, so the
   *  Settings toggle reflects the real off-by-default state instead of showing
   *  a misleading ON. Must match the default the consumer passes to getFlag. */
  defaultOn?: boolean;
}

export const FEATURE_FLAG_META: readonly FeatureFlagMeta[] = [
  {
    key: "scanInsights",
    label: "Scan INSIGHTS.md",
    description: "Reads INSIGHTS.md from each project on every scan.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanTodos",
    label: "Scan TODO.md",
    description: "Reads TODO.md and surfaces pending/completed counts.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanManualSteps",
    label: "Scan MANUAL_STEPS.md",
    description: "Reads MANUAL_STEPS.md from each project.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanClaudeSessions",
    label: "Scan Claude history",
    description: "Joins ~/.claude/history.jsonl into per-project session counts.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanWorktrees",
    label: "Scan Claude worktrees",
    description: "Discovers --claude-worktrees-* directories and overlays their TODO/INSIGHTS/STEPS.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanDockerCompose",
    label: "Scan docker-compose",
    description: "Parses docker-compose.yml for port mappings.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "manualStepsWatcher",
    label: "Manual steps watcher",
    description: "Background fs.watch of MANUAL_STEPS.md across all projects (drives Pulse + toasts).",
    group: "active",
    appliesAt: "watcher",
    wired: false,
  },
  {
    key: "gitStatusCache",
    label: "Git status cache",
    description: "Background batched `git status --porcelain` enqueued on each dashboard load.",
    group: "active",
    appliesAt: "watcher",
    wired: false,
  },
  {
    key: "usageAnalytics",
    label: "Usage analytics",
    description: "Cost calc and token aggregation on /usage.",
    group: "active",
    appliesAt: "ingest",
    wired: false,
  },
  {
    key: "agentSkillIndexer",
    label: "Agent + skill indexer",
    description: "Walks user/plugin/project trees to build the agent and skill catalog.",
    group: "active",
    appliesAt: "ingest",
    wired: false,
  },
  {
    key: "devServerControl",
    label: "Dev server control",
    description: "Per-project start/stop/restart buttons.",
    group: "active",
    appliesAt: "ui",
    wired: false,
  },
  {
    key: "liveActivity",
    label: "Live activity (hook server)",
    description: "POST /api/hooks accepts Claude Code lifecycle events.",
    group: "active",
    appliesAt: "ingest",
    wired: true,
  },
  {
    key: "taskDispatcher",
    label: "Task dispatcher",
    description: "Dispatcher loop that spawns claude CLI child processes and tracks runs.",
    group: "active",
    appliesAt: "ingest",
    wired: true,
  },
  {
    key: "mcpSecurityScan",
    label: "MCP security scan",
    description:
      "Runs the deobfuscation + pattern engine across MCP servers. " +
      "Static-surface scan (command/args/url/env/name) runs unconditionally once wired. " +
      "Live tool-list introspection is gated behind this flag.",
    group: "active",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "gsdPlanning",
    label: "GSD planning scanner",
    description: "Scans per-project .planning/ directories (produced by the GSD skill) and surfaces a Planning tab on the project detail page.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "agentView",
    label: "Agent View (live Kanban)",
    description: "Reads the Claude daemon roster + JSONL appends to power the /agent-view live session Kanban. Defaults on.",
    group: "active",
    appliesAt: "watcher",
    wired: true,
  },
  {
    key: "claudeStatusAlerts",
    label: "Claude status alerts",
    description: "Polls status.claude.com for incidents and shows a banner + toast when Claude services are degraded. Defaults on.",
    group: "active",
    appliesAt: "ui",
    wired: true,
  },
  {
    key: "configLint",
    label: "Config Lint",
    description: "Workspace-wide config audit: CLAUDE.md, skills, agents, commands, hooks, MCPs, plugins, output styles, and LSPs.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanBoard",
    label: "Scan BOARD.md",
    description: "Reads BOARD.md (epics → issues) from each project for the Board.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "scanOps",
    label: "Scan OPERATIONS.md",
    description:
      "Reads OPERATIONS.md (backups, monitoring, on-call, secrets, restore) for the per-project Operations panel.",
    group: "passive",
    appliesAt: "scan",
    wired: true,
  },
  {
    key: "githubActivity",
    label: "GitHub activity",
    description:
      "Background `gh` fetch of open PRs, CI status, and last push per project (drives the GitHub strip on cards + detail).",
    group: "active",
    appliesAt: "watcher",
    wired: true,
  },
  {
    key: "mcpHealth",
    label: "MCP server health",
    description:
      "Background reachability probes of user-scope MCP servers (drives the health strip in the top bar).",
    group: "active",
    appliesAt: "ui",
    wired: true,
  },
  {
    key: "rscHydration",
    label: "Server-render data pages (RSC hydration)",
    description:
      "Read-heavy pages (sessions, usage, stats, agents, skills, insights, commands, manual-steps, templates, config) prefetch their data on the server and stream it into the TanStack Query cache, so they paint with data instead of a loading spinner. Defaults ON; toggle OFF in Settings to fall back to client fetch-on-mount.",
    group: "active",
    appliesAt: "ui",
    wired: true,
    // Defaults ON: the server gate reads getFlag(..., true) (the module default),
    // so the Settings toggle reflects the on-by-default state. Toggling OFF falls
    // back to the client fetch-on-mount path, which remains intact.
    defaultOn: true,
  },
  {
    key: "serverActions",
    label: "Server Actions for mutations",
    description:
      "Routes the two live writes (toggle a manual step, change a project's status) through Next.js Server Actions instead of POST/PUT API routes. Same result, one fewer client fetch hop, and the project-status change no longer forces a full page reload. Defaults ON; toggle OFF in Settings to fall back to the POST/PUT route path.",
    group: "active",
    appliesAt: "ui",
    wired: true,
    // Defaults ON: client callers read getFlag(..., true) (the module default),
    // so the Settings toggle reflects the on-by-default state. Toggling OFF falls
    // back to the POST/PUT fetch route path, which remains intact.
    defaultOn: true,
  },
  {
    key: "liveEvents",
    label: "Live updates (SSE)",
    description:
      "Opens one Server-Sent Events stream (/api/events) that pushes 'data changed' signals so pages refresh in real time instead of on a timer (e.g. the sessions list drops its 15s poll). Defaults ON; toggle OFF in Settings to fall back to timer-based polling.",
    group: "active",
    appliesAt: "ui",
    wired: true,
    // Defaults ON: client callers read getFlag(..., true) (the module default),
    // so the Settings toggle reflects the on-by-default state. Toggling OFF falls
    // back to the timer-based polling path, which remains intact.
    defaultOn: true,
  },
];

/**
 * Read a feature flag from a (possibly absent) MinderConfig.featureFlags map.
 *
 * Defaults to ON: missing keys behave exactly like the day before flags
 * existed. Pass `defaultOn = false` for opt-in flags introduced later.
 *
 * Accepts the raw flags map rather than the whole config so callers in hot
 * paths (per-project scan loop) don't refetch config on every check — they
 * read it once and pass the slice down.
 */
export function getFlag(
  flags: MinderConfig["featureFlags"] | undefined,
  key: FeatureFlagKey,
  defaultOn = true,
): boolean {
  if (!flags) return defaultOn;
  const v = flags[key];
  if (v === undefined) return defaultOn;
  return v;
}

/** Type guard used by the /api/config validator. */
export function isFeatureFlagKey(s: unknown): s is FeatureFlagKey {
  return typeof s === "string" && (FEATURE_FLAG_KEYS as readonly string[]).includes(s);
}
