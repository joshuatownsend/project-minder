export interface ProjectData {
  slug: string;
  name: string;
  path: string;
  status: ProjectStatus;

  // Tech stack
  framework?: string;
  frameworkVersion?: string;
  orm?: string;
  styling?: string;
  monorepoType?: string;
  dependencies: string[];

  // Ports
  devPort?: number;
  dbPort?: number;
  dockerPorts: PortMapping[];

  // Database
  database?: DatabaseInfo;

  // External services
  externalServices: string[];

  // Git
  git?: GitInfo;

  // Claude
  claude?: ClaudeInfo;

  // TODOs
  todos?: TodoInfo;

  // Manual Steps
  manualSteps?: ManualStepsInfo;

  // Insights
  insights?: InsightsInfo;

  // Worktree overlays
  worktrees?: WorktreeOverlay[];

  // Claude config (project-local)
  hooks?: HooksInfo;
  mcpServers?: McpServersInfo;

  // CI/CD
  cicd?: CiCdInfo;

  // Timestamps
  lastActivity?: string;
  scannedAt: string;
}

export type ProjectStatus = "active" | "paused" | "archived";

export type SessionStatus = "working" | "needs_attention" | "idle";

export type LiveSessionStatus = "working" | "approval" | "waiting" | "other";

export interface LiveSession {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  worktreeLabel?: string;
  status: LiveSessionStatus;
  mtime: string;
  lastToolName?: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryFile {
  name: string;
  type?: MemoryType;
  description?: string;
  mtime: string;
  size: number;
}

export interface MemoryData {
  indexMd?: string;
  files: MemoryFile[];
}

export interface PortMapping {
  service: string;
  host: number;
  container: number;
}

export interface DatabaseInfo {
  type: string;
  host: string;
  port: number;
  name: string;
}

export interface GitInfo {
  branch: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isDirty: boolean;
  uncommittedCount: number;
  remoteUrl?: string;
}

export interface ClaudeInfo {
  lastSessionDate?: string;
  lastPromptPreview?: string;
  sessionCount: number;
  claudeMdSummary?: string;
  mostRecentSessionStatus?: SessionStatus;
  mostRecentSessionId?: string;
}

export interface TodoInfo {
  total: number;
  completed: number;
  pending: number;
  items: TodoItem[];
}

export interface TodoItem {
  text: string;
  completed: boolean;
  lineNumber?: number;
}

export interface ManualStepEntry {
  date: string;           // "2026-03-17 14:32"
  featureSlug: string;    // "auth"
  title: string;          // "Clerk + Vercel Authentication Setup"
  steps: ManualStep[];
}

export interface ManualStep {
  text: string;           // "Install Clerk package"
  completed: boolean;
  details: string[];      // indented lines beneath the step
  lineNumber: number;     // 1-based line number for write-back
}

export interface ManualStepsInfo {
  entries: ManualStepEntry[];
  totalSteps: number;
  pendingSteps: number;
  completedSteps: number;
}

export interface InsightEntry {
  id: string;              // hash of content for dedup
  content: string;         // the insight text (between markers)
  sessionId: string;       // which conversation it came from
  date: string;            // ISO timestamp from the JSONL entry
  project: string;         // project slug
  projectPath: string;     // full Windows path
}

export interface InsightsInfo {
  entries: InsightEntry[];
  total: number;
}

export interface WorktreeOverlay {
  branch: string;           // e.g. "feature/gitwc"
  worktreePath: string;     // full path to worktree directory
  todos?: TodoInfo;
  manualSteps?: ManualStepsInfo;
  insights?: InsightsInfo;
}

export interface WorktreeStatus {
  worktreePath: string;
  branch: string;
  isDirty: boolean;
  uncommittedCount: number;
  isMergedLocally: boolean;       // git branch --merged main
  isRemoteBranchDeleted: boolean; // git ls-remote --heads origin <branch> returned empty
  isStale: boolean;               // isMergedLocally && isRemoteBranchDeleted
  lastCommitDate?: string;        // from git log -1 --format=%aI
}

export interface PortConflict {
  port: number;
  projects: string[];
  type: "dev" | "db" | "docker";
}

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
  | "liveActivity";

/** Schedule mode used by Wave 8's quota burndown projection. Persisted now
 *  so the Settings UI can capture it before the burndown chart lands. */
export type ScheduleMode = "weekdays" | "vibe-coder" | "24x7" | "custom";

/** Pricing override rule. Placeholder shape; Wave 8 (Cluster S) tightens
 *  the contract and adds the Settings editor. */
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

export interface MinderConfig {
  statuses: Record<string, ProjectStatus>;
  hidden: string[]; // directory names to skip during scan
  portOverrides: Record<string, number>; // slug -> custom dev port
  devRoot: string; // root directory to scan for projects (kept for backward compat; use getDevRoots())
  devRoots?: string[]; // multiple scan roots; if set, takes precedence over devRoot
  scanBatchSize?: number; // projects scanned in parallel per root (default 10)
  defaultSort?: "activity" | "name" | "claude"; // dashboard default sort
  defaultStatusFilter?: "all" | "active" | "paused" | "archived"; // dashboard default filter
  viewMode?: "full" | "compact" | "list"; // dashboard card layout
  pinnedSlugs?: string[]; // slugs pinned to top of all dashboard views
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
  /** Telegram bridge credentials. Wave 7 (P) honors. */
  telegram?: { botToken?: string; chatId?: string };
  /** Per-model pricing overrides. Wave 8 (S) honors. */
  pricingRules?: PricingRule[];
}

export interface ClaudeUsageStats {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTurns: number;
  toolUsage: Record<string, number>;
  errorCount: number;
  modelsUsed: string[];
  costEstimate: number; // rough USD estimate
  conversationCount: number;
}

export interface StatsData {
  projectCount: number;
  hiddenCount: number;
  frameworks: Record<string, number>;
  orms: Record<string, number>;
  styling: Record<string, number>;
  services: Record<string, number>;
  databases: Record<string, number>;
  statuses: Record<string, number>;
  activity: { today: number; thisWeek: number; thisMonth: number; older: number; none: number };
  todoHealth: { total: number; completed: number; pending: number };
  manualStepsHealth: { total: number; completed: number; pending: number };
  claudeSessions: { total: number; projectsWithSessions: number };
  claudeUsage?: ClaudeUsageStats;
}

export interface SessionRecap {
  content: string;
  timestamp: string;
  slug?: string; // human-readable session nickname, e.g. "dynamic-giggling-quokka"
}

export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  projectSlug: string;
  projectName: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  initialPrompt?: string;
  lastPrompt?: string;
  recaps?: SessionRecap[];
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costEstimate: number;
  toolUsage: Record<string, number>;
  modelsUsed: string[];
  gitBranch?: string;
  subagentCount: number;
  errorCount: number;
  isActive: boolean;
  status: SessionStatus;
  skillsUsed: Record<string, number>; // skill name → invocation count
  oneShotRate?: number;
  searchableText?: string;
  /**
   * Claude Code's human-readable session label (e.g. `quirky-scribbling-plum`).
   * Stable across `--resume`/`--continue` invocations: a continued
   * session inherits the slug while getting a new `sessionId`. Used by
   * the SessionsBrowser "continued from …" badge and by the
   * `/sessions/<slug>` URL resolver. Undefined on legacy sessions whose
   * JSONL never exposed a slug, and on freshly-written rows that
   * haven't yet been re-indexed since schema v5 landed.
   */
  slug?: string;
  /**
   * The previous `sessionId` in the slug-grouped continuation chain,
   * or `undefined` for the first session of a chain (or when slug is
   * unknown). Populated by the post-reconcile linking pass in
   * `refreshContinuationLinks`. The chain is computed from
   * `(slug, start_ts, session_id)` ordering — see ingest's
   * `refreshContinuationLinks` for the exact tie-break.
   */
  continuedFromSessionId?: string;
}

export interface TimelineEvent {
  type: "user" | "assistant" | "tool_use" | "thinking" | "error";
  timestamp?: string;
  content: string;
  toolName?: string;
  tokenCount?: number;
}

export interface FileOperation {
  path: string;
  operation: string;
  timestamp?: string;
  toolName: string;
}

export interface SubagentInfo {
  agentId: string;
  type: string;
  description: string;
  messageCount: number;
  toolUsage: Record<string, number>;
}

export interface SessionDetail extends SessionSummary {
  timeline: TimelineEvent[];
  fileOperations: FileOperation[];
  subagents: SubagentInfo[];
}

// ─── Claude config: hooks, MCP servers, plugins ──────────────────────────────

export type HookSource = "project" | "local" | "user";

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookEntry {
  /** PreToolUse | PostToolUse | SessionStart | UserPromptSubmit | Stop | etc. */
  event: string;
  /** Tool/event matcher (e.g. "Edit|Write", "Bash"). Optional. */
  matcher?: string;
  commands: HookCommand[];
  source: HookSource;
  /** Absolute file path the entry came from — used for the future template-builder. */
  sourcePath: string;
}

export interface HooksInfo {
  entries: HookEntry[];
}

export type McpTransport = "stdio" | "http" | "sse" | "unknown";

/**
 * Where Project Minder read this MCP server from. Per Claude Code's
 * docs (https://code.claude.com/docs/en/settings):
 *
 *  - "project"  — `<project>/.mcp.json`
 *  - "user"     — top-level `mcpServers` in `~/.claude.json`, OR the
 *                 `mcpServers` key in `~/.claude/settings.json` (legacy
 *                 location, preserved because plugin scenarios can still
 *                 touch it)
 *  - "local"    — per-project entry in `~/.claude.json`
 *                 (`projects.<path>.mcpServers`); private to user, scoped
 *                 to one project
 *  - "plugin"   — `<plugin-root>/.mcp.json` of an installed plugin.
 *                 Per Claude Code's plugin spec, `plugin.json` is a
 *                 metadata-only manifest (name/version/description/author)
 *                 and is NOT read for MCP entries.
 *  - "desktop"  — Claude Desktop's `claude_desktop_config.json` (the
 *                 separate desktop app; importable via
 *                 `claude mcp add-from-claude-desktop`)
 *  - "managed"  — IT-deployed `managed-mcp.json` under the platform's
 *                 system directory
 *
 * Only "project" and "user" are write targets via the apply layer; the
 * other sources are READ-ONLY in Project Minder. applyMcp rejects
 * non-write sources explicitly so a misuse is loud.
 */
export type McpSource = "project" | "user" | "local" | "plugin" | "desktop" | "managed";

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Env variable KEY NAMES only — never values (avoid leaking secrets). */
  envKeys?: string[];
  source: McpSource;
  sourcePath: string;
}

export interface McpServersInfo {
  servers: McpServer[];
}

export interface PluginEntry {
  name: string;
  marketplace: string;
  enabled: boolean;
  blocked: boolean;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  installPath?: string;
  gitCommitSha?: string;
  pluginRepoUrl?: string;
}

export interface PluginsInfo {
  plugins: PluginEntry[];
}

// ─── CI/CD ───────────────────────────────────────────────────────────────────

export interface WorkflowJob {
  id: string;
  name?: string;
  runsOn?: string;
  /** Reusable-workflow reference (`jobs.<id>.uses`). */
  uses?: string;
  /** Deduped `uses:` references from steps (e.g. "actions/checkout@v4"). */
  actionUses: string[];
}

export interface Workflow {
  /** Absolute path to the workflow file. */
  file: string;
  name?: string;
  /** Normalized triggers: push | pull_request | schedule | workflow_dispatch | ... */
  triggers: string[];
  /** Cron expressions from `on.schedule[].cron`. */
  cron: string[];
  jobs: WorkflowJob[];
  /** False if YAML parsing failed; the entry still surfaces by file name. */
  parseOk: boolean;
}

export type HostingPlatform =
  | "vercel"
  | "railway"
  | "fly"
  | "render"
  | "netlify"
  | "heroku"
  | "docker";

export interface HostingTarget {
  platform: HostingPlatform;
  sourcePath: string;
  detail?: Record<string, string | number | boolean | string[]>;
}

export interface VercelCron {
  path: string;
  schedule: string;
  sourcePath: string;
}

export interface DependabotUpdate {
  ecosystem: string;
  directory?: string;
  schedule?: string;
  sourcePath: string;
}

export interface CiCdInfo {
  workflows: Workflow[];
  hosting: HostingTarget[];
  vercelCrons: VercelCron[];
  dependabot: DependabotUpdate[];
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

export interface ScanResult {
  projects: ProjectData[];
  portConflicts: PortConflict[];
  hiddenCount: number;
  scannedAt: string;
}

// ─── Template Mode ──────────────────────────────────────────────────────────
// V1: single-unit copy across projects. V2 will add TemplateManifest +
// whole-template apply + new-project bootstrap.

export type UnitKind =
  | "agent"
  | "skill"
  | "command"
  | "hook"
  | "mcp"
  | "plugin"
  | "workflow"
  | "settingsKey";

export type ConflictPolicy = "skip" | "overwrite" | "merge" | "rename";

export type ApplySource =
  | { kind: "project"; slug: string }
  | { kind: "user" }
  /** Internal-only: direct path to a "virtual project root" — used by the
   *  template apply layer. Never accepted by the public API validator
   *  (would be a path-safety hole). */
  | { kind: "path"; path: string };

export type ApplyTarget =
  | { kind: "existing"; slug: string }
  | {
      kind: "new";
      /** Display name for logs / future scan results. */
      name: string;
      /** Path relative to the first configured devRoot. Validated against getDevRoots(). */
      relPath: string;
      /** Run `git init` after mkdir. Default true. */
      gitInit?: boolean;
    }
  /** Internal-only: direct path target — used by applyTemplate after it has
   *  bootstrapped a "new" target into a real directory. Never accepted by the
   *  public API validator. */
  | { kind: "path"; path: string };

export interface UnitRef {
  kind: UnitKind;
  key: string;
}

export interface ApplyRequest {
  unit: UnitRef;
  source: ApplySource;
  target: ApplyTarget;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}

export type ApplyStatus =
  | "applied"
  | "skipped"
  | "merged"
  | "would-apply"
  | "error";

export interface ApplyResult {
  ok: boolean;
  status: ApplyStatus;
  changedFiles: string[];
  diffPreview?: string;
  warnings?: string[];
  error?: { code: string; message: string };
}

// ─── Template Mode V2 — manifests + registry ─────────────────────────────────

/** A single unit selected into a template. The source content lives either in
 *  the live source project (for kind:"live" manifests) or in
 *  `<devRoot>/.minder/templates/<slug>/bundle/` (for kind:"snapshot" manifests).
 *  In either case the `key` is the same as Template Mode's per-kind unit key
 *  (see `unitKey.ts`). */
export interface TemplateUnitRef {
  kind: UnitKind;
  key: string;
  /** Display label, captured at promotion time. May drift in live mode. */
  name?: string;
  description?: string;
}

export interface TemplateUnitInventory {
  agents: TemplateUnitRef[];
  skills: TemplateUnitRef[];
  commands: TemplateUnitRef[];
  hooks: TemplateUnitRef[];
  mcp: TemplateUnitRef[];
  /** Plugin enable list. Keys are `<pluginName>@<marketplace>` (or just
   *  `<pluginName>` when there's no marketplace). Applying a plugin unit
   *  flips the target's `.claude/settings.json` enabledPlugins to true. */
  plugins: TemplateUnitRef[];
  /** GitHub Actions workflows. Keys are relative paths under
   *  `.github/workflows/` (e.g., "ci.yml"). Apply is file-replace only —
   *  workflows have no internal merge semantics. */
  workflows: TemplateUnitRef[];
  /** Generic `.claude/settings.json` keys. Keys are dotted JSON paths
   *  (e.g. "permissions.allow", "env.MY_VAR", "statusLine"). Apply uses a
   *  deep-merge with conflict-policy semantics; certain arrays
   *  (`permissions.allow` / `permissions.ask` / `permissions.deny`) use
   *  concat-and-dedupe. Hooks / MCP / plugin enables have dedicated unit
   *  kinds — picking those keys here would shadow the specialized paths,
   *  so the UI excludes them from the settingsKey picker. */
  settings: TemplateUnitRef[];
}

export type TemplateKind = "live" | "snapshot";

export interface TemplateManifest {
  schemaVersion: 1;
  slug: string;
  name: string;
  description?: string;
  kind: TemplateKind;
  /** When kind === "live": project slug whose .claude/ + .mcp.json this template tracks. */
  liveSourceSlug?: string;
  createdAt: string;
  updatedAt: string;
  units: TemplateUnitInventory;
}

/** A request to apply an entire template. */
export interface ApplyTemplateRequest {
  templateSlug: string;
  target: ApplyTarget;
  /** Default conflict policy applied to every unit unless `perUnitConflict` overrides. */
  conflictDefault: ConflictPolicy;
  /** Override the policy for specific units. Key shape: `<kind>:<unit-key>`. */
  perUnitConflict?: Record<string, ConflictPolicy>;
  dryRun?: boolean;
}

export interface ApplyTemplateResult {
  ok: boolean;
  /** Per-unit outcomes in inventory order. */
  results: Array<{
    unit: TemplateUnitRef;
    result: ApplyResult;
  }>;
  /** Aggregate counters useful for the apply-modal summary. */
  summary: {
    applied: number;
    merged: number;
    skipped: number;
    errors: number;
    wouldApply: number;
  };
  /** Bootstrap details when `target.kind === "new"`. */
  bootstrap?: {
    createdPath: string;
    gitInitialized: boolean;
  };
  error?: { code: string; message: string };
}

/** Slash command discovered under .claude/commands/. Mirrors AgentEntry shape, minus tools/model. */
export interface CommandEntry {
  id: string;                    // command:<source>:<prefix>:<relPath>
  slug: string;                  // basename without .md
  name: string;                  // frontmatter.name or slug
  description?: string;
  source: "user" | "plugin" | "project";
  pluginName?: string;
  projectSlug?: string;
  category?: string;
  filePath: string;
  bodyExcerpt: string;
  frontmatter: Record<string, unknown>;
  mtime: string;
  ctime: string;
  /** Comma-separated `allowed-tools` frontmatter parsed into an array. */
  allowedTools?: string[];
  argumentHint?: string;
  isSymlink?: boolean;
  realPath?: string;
}
