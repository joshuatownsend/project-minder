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
    description: "Cost calc and token aggregation on /usage. Wired in a later wave.",
    group: "active",
    appliesAt: "ingest",
    wired: false,
  },
  {
    key: "agentSkillIndexer",
    label: "Agent + skill indexer",
    description: "Walks user/plugin/project trees to build the catalog. Wired in a later wave.",
    group: "active",
    appliesAt: "ingest",
    wired: false,
  },
  {
    key: "devServerControl",
    label: "Dev server control",
    description: "Per-project start/stop/restart buttons. Wired in a later wave.",
    group: "active",
    appliesAt: "ui",
    wired: false,
  },
  {
    key: "liveActivity",
    label: "Live activity (hook server)",
    description: "POST /api/hooks accepts Claude Code lifecycle events. Wave 7.",
    group: "active",
    appliesAt: "ingest",
    wired: false,
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
