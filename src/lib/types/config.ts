import type { ProjectStatus } from "./project";
import type { ConflictPolicy } from "./template";
import type { PluginsInfo, HooksInfo, McpServersInfo } from "./claudeConfig";
import type { NotificationRule } from "../notifications/rules/types";

/** Keys in MinderConfig.featureFlags. Each flag defaults to ON; `false`
 *  disables the named subsystem on next scan / next server restart. The
 *  union is the source of truth — adding a key here automatically widens
 *  `getFlag()`'s accepted argument, the Settings UI iteration, and the
 *  /api/config validator. */
export type FeatureFlagKey =
  | "scanInsights"
  | "scanTodos"
  | "scanManualSteps"
  | "scanClaudeSessions"
  | "scanWorktrees"
  | "scanDockerCompose"
  | "manualStepsWatcher"
  | "gitStatusCache"
  | "usageAnalytics"
  | "agentSkillIndexer"
  | "devServerControl"
  | "liveActivity"
  | "taskDispatcher"
  | "mcpSecurityScan"
  | "gsdPlanning"
  | "agentView"
  | "claudeStatusAlerts"
  | "configLint"
  | "semanticSearch"
  | "semanticAutoBackfill"
  | "quotaAwareDispatch"
  | "configDrift"
  | "scanBoard"
  | "scanOps"
  | "githubActivity"
  | "blockingApprovals"
  | "mcpHealth"
  | "mcpHealthStdioProbe"
  | "burnHud"
  | "rscHydration"
  | "serverActions"
  | "liveEvents"
  | "demoMode"
  | "workflowLauncher"
  | "workflowCatalog"
  | "notificationRules"
  | "engagementReport";

/**
 * Every Claude Code lifecycle hook event, in rough lifecycle order.
 *
 * **Single source of truth.** This list previously existed three times over —
 * here as a union, and as hand-maintained `Set`s in `/api/hooks` and in the
 * notification-rule validator. They were identical by luck rather than by
 * construction, and the failure mode of a drift is quiet: the route rejects an
 * event the rule validator happily accepts, so a rule targeting it can be saved
 * and can never fire. Both now derive from this array.
 *
 * Transcribed from the hooks reference (checked 2026-08-06). Minder had 9 of
 * the 31 documented events, so a hook wired to any of the other 22 — `PostCompact`,
 * `SubagentStart`, `PermissionDenied`, `FileChanged` — was rejected with a 400 at
 * the ingest route. Accepting an event is cheap and independent of modelling its
 * payload in detail: see `HookPayload` for which ones get typed fields and which
 * are captured generically.
 */
export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "Setup",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
  "SessionEnd",
] as const;

/** Claude Code lifecycle hook event names sent in the hook stdin payload. */
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export type ScheduleMode = "weekdays" | "vibe-coder" | "24x7" | "custom";

export const SCHEDULE_MODES: { value: ScheduleMode; label: string }[] = [
  { value: "weekdays",   label: "Weekdays (Mon–Fri)" },
  { value: "vibe-coder", label: "Vibe coder (~70% of hours)" },
  { value: "24x7",       label: "24 × 7 (always on)" },
  { value: "custom",     label: "Custom" },
];

/** Pricing override rule. Placeholder shape; Wave 8 (Cluster S) tightens
 *  the contract and adds the Settings editor. */
/** Claude.ai subscription tier for budget cap reference. */
export type SubscriptionTier = "pro" | "max5x" | "max20x" | "api";

/** Per-session / per-day / per-hour spending limits for Agent View alerts. */
export interface AgentBudgets {
  /** Maximum USD per session — card tints amber at 80%, red at 100%. Triggers OS notification on crossing. */
  sessionUsd?: number;
  /** Maximum USD per day — drives the SpendBanner progress bar on /agent-view. */
  dailyUsd?: number;
}

export interface PricingRule {
  /** Wildcard pattern matched against the model id (e.g. "claude-opus-*"). */
  pattern: string;
  /** USD per 1M input tokens. */
  inputUsdPerMillion?: number;
  /** USD per 1M output tokens. */
  outputUsdPerMillion?: number;
  /** USD per 1M cache-read tokens. */
  cacheReadUsdPerMillion?: number;
  /** USD per 1M cache-create tokens. */
  cacheCreateUsdPerMillion?: number;
}

/** One cross-environment path prefix rewrite. See MinderConfig.pathMappings. */
export interface PathMapping {
  /** Prefix as recorded by the foreign environment (e.g. "/home/josh"). */
  from: string;
  /** How this machine reaches the same directory (e.g. "\\wsl.localhost\Ubuntu-26.04\home\josh"). */
  to: string;
}

export interface MinderConfig {
  statuses: Record<string, ProjectStatus>;
  hidden: string[]; // directory names to skip during scan
  portOverrides: Record<string, number>; // slug -> custom dev port
  devRoot: string; // root directory to scan for projects (kept for backward compat; use getDevRoots())
  devRoots?: string[]; // multiple scan roots; if set, takes precedence over devRoot
  /** Additional Claude home dirs beyond ~/.claude (e.g. a WSL distro's
   *  \\wsl.localhost\<distro>\home\<user>\.claude). Use getClaudeHomes(). */
  claudeHomes?: string[];
  /** Cross-environment path prefix mappings: how a path recorded inside another
   *  environment (`from`, e.g. "/home/josh") is reached from this machine
   *  (`to`, e.g. "\\wsl.localhost\Ubuntu-26.04\home\josh"). Lets sessions
   *  recorded in a WSL distro correlate with their UNC-scanned projects. */
  pathMappings?: PathMapping[];
  scanBatchSize?: number; // projects scanned in parallel per root (default 10)
  defaultSort?: "activity" | "name" | "claude"; // dashboard default sort
  defaultStatusFilter?: "all" | "active" | "paused" | "archived"; // dashboard default filter
  viewMode?: "full" | "compact" | "list"; // dashboard card layout
  pinnedSlugs?: string[]; // slugs pinned to top of all dashboard views
  /** Checkout paths opted out of project grouping, for users who want two
   *  clones of the same repo kept genuinely separate. Keyed on PATH rather
   *  than slug because slugs move between rescans when `devRoots` is
   *  reordered (see `resolveProjectSlug` in `scanner/index.ts`), which would
   *  silently re-merge a pair the user had split. */
  ungroupedPaths?: string[];
  templates?: {
    /** Default conflict policy for the apply-template modal. */
    defaultConflictPolicy?: ConflictPolicy;
    /** Most recently applied template slug — used to seed the modal. */
    lastUsedSlug?: string;
  };
  /** Subsystem on/off toggles. Missing keys default to ON. See FeatureFlagKey. */
  featureFlags?: Partial<Record<FeatureFlagKey, boolean>>;
  /** ISO 4217 currency code (e.g. "USD", "EUR"). Wave 8 (S) honors. */
  currency?: string;
  /** Schedule shape used by quota burndown. Wave 8 (S) honors. */
  scheduleMode?: ScheduleMode;
  /** Preferred terminal application (e.g. "wt", "iterm"). Wave 7 (P) honors. */
  terminal?: string;
  /** Telegram bridge config. Bot token is stored in secrets.json, not here. Wave 7 (P) honors. */
  telegram?: { chatId?: string };
  /**
   * User-defined notification rules, evaluated against every live hook event.
   * The open-ended successor to `notificationPrefs.events` below (which stays
   * for the two built-in triggers). Order is evaluation order.
   */
  notificationRules?: NotificationRule[];
  /** Notification preferences. Wave 7 (P) honors. */
  notificationPrefs?: {
    events: {
      "manual-step-added"?: { push?: boolean; telegram?: boolean; os?: boolean };
      "awaiting-permission"?: { push?: boolean; telegram?: boolean; os?: boolean };
    };
  };
  /** LLM auto-title config. API key stored in secrets.json, not here. Wave 7 (P) honors. */
  autoTitle?: { endpoint?: string; model?: string };
  /** Live activity hook receiver config. Wave 7 (Q) honors. */
  liveActivity?: {
    /** Full URL of the hook receiver endpoint (e.g. http://localhost:4100/api/hooks). */
    hookUrl?: string;
    /** Hook event names to register. Defaults to SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop. */
    events?: HookEventName[];
  };
  /** OTEL ingest config. Wave 8 (R) honors. */
  otel?: {
    /** OTLP base endpoint written into OTEL_EXPORTER_OTLP_ENDPOINT (default: http://localhost:4100/api/otel). */
    endpoint?: string;
  };
  /** Stored port preference only — NOT the live bound port. Nothing at server-boot
   *  (dev CLI, service-install launcher generation, or the tray) reads this value;
   *  it exists purely so the Settings UI can persist "what the user wants" and
   *  render copy-paste commands for the run mode the user actually uses. The port
   *  this page is being served on is read client-side from `window.location.port`.
   *  Undefined/absent means DEFAULT_PORT (4100, see src/lib/boundPort.ts). */
  port?: number;
  /** Per-model pricing overrides. Wave 8 (S) honors. */
  pricingRules?: PricingRule[];
  /** When true, the task dispatcher loop skips all spawning until cleared. Wave 9.2 (emergency stop). */
  emergencyStop?: boolean;
  /** Adapter ids to enable. Defaults to ["claude"]. Wave 10.2a (multi-platform). */
  enabledAdapters?: string[];
  /** User-defined keyboard shortcut overrides. Keys are ShortcutActionId strings. Wave 12.2. */
  keyboardShortcuts?: Record<string, string>;
  /** Claude.ai subscription tier — used to compute the daily spend cap reference in Agent View. */
  subscriptionTier?: SubscriptionTier;
  /** Per-session and per-day spend limits that drive Agent View budget alerts. */
  budgets?: AgentBudgets;
  /** Agent View / Kanban live observability config. */
  agentView?: {
    /** Sessions inactive longer than this drop to "stopped". Defaults to 180. */
    abandonThresholdMin?: number;
  };
  /** Wave M.4 — per-absPath "Keep for N days" suppressions for /memory/triage.
   *  Values are ISO 8601 timestamps; entries with a past-dated value are
   *  ignored on read (treated as lapsed, not pruned eagerly). */
  memoryTriage?: {
    suppressUntil?: Record<string, string>;
  };
  /** Screenshot-to-React MCP server config. API keys are NEVER stored here —
   *  `apiKeyEnvVar` names the env var the MCP server reads at request time. */
  screenshotToCode?: {
    /** Vendor whose REST API the MCP server will hit. */
    provider: "gemini" | "openai" | "anthropic";
    /** Vendor-specific model id (e.g. "gemini-2.5-flash", "gpt-4o", "claude-sonnet-4-5"). */
    model: string;
    /** Name of the env var holding the API key (e.g. "GOOGLE_API_KEY"). */
    apiKeyEnvVar: string;
  };
}

/** A single top-level entry from `~/.claude/settings.json`, excluding keys
 *  that already have dedicated catalog tabs (hooks, mcpServers, enabledPlugins). */
export interface SettingsKeyEntry {
  /** Top-level key name (e.g. "statusLine", "permissions"). */
  keyPath: string;
  value: unknown;
}

export interface UserConfig {
  plugins: PluginsInfo;
  hooks: HooksInfo;
  mcpServers: McpServersInfo;
  settingsKeys: SettingsKeyEntry[];
}

/** Catalog kinds surfaced by `/api/claude-config`. "all" returns every section. */
export type ConfigType = "hooks" | "plugins" | "mcp" | "cicd" | "settingskeys" | "all";

export const CONFIG_TYPES: readonly ConfigType[] = ["hooks", "plugins", "mcp", "cicd", "settingskeys", "all"];
