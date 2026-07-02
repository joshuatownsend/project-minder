/**
 * Snapshot of the SQLite-index schema-readiness state machine in
 * `src/lib/data/index.ts`. Lives here (not next to the state machine)
 * because `data/index.ts` is `server-only` and `SettingsPage` needs the
 * type for the DB-status footer that polls `/api/health`.
 */
export type InitStateKind =
  | "idle"
  | "in-flight"
  | "success"
  | "transient-failed"
  | "permanent-failed";

export interface InitStatus {
  state: InitStateKind;
  attempts: number;
  quarantineRuns: number;
  /** Wall-clock ms when the last failure was committed; null otherwise. */
  failedAt: number | null;
  lastError: { message: string; code?: string } | null;
}

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

  // CLAUDE.md health audit — surfaced as a badge on ProjectCard and
  // full panel on ProjectDetail. Required: the scanner always
  // populates it as either ClaudeMdAuditAbsent (no file) or
  // ClaudeMdAuditPresent (full measurement). Consumers switch on
  // `hasClaudeMd` to access the measurement fields without `?.`.
  claudeMdAudit: ClaudeMdAuditInfo;

  // Workspace-wide config lint (skills, agents, hooks, MCPs, plugins, …).
  // Populated when the `configLint` feature flag is on; absent otherwise.
  configLint?: LintReport;

  // TODOs
  todos?: TodoInfo;

  // Manual Steps
  manualSteps?: ManualStepsInfo;

  // Insights
  insights?: InsightsInfo;

  // Board (BOARD.md epics → issues)
  board?: BoardInfo;

  // Operations runbook (OPERATIONS.md — curated facts, living-checklist)
  operations?: OperationsInfo;

  // Worktree overlays
  worktrees?: WorktreeOverlay[];

  // Claude config (project-local)
  hooks?: HooksInfo;
  mcpServers?: McpServersInfo;
  outputStyles?: OutputStylesInfo;
  lspConfig?: LspConfigInfo;

  // CI/CD
  cicd?: CiCdInfo;

  // Catalog counts (project-local agents/skills)
  agentCount?: number;
  skillCount?: number;

  // GSD project planning (.planning/ directory)
  gsdPlanning?: GsdPlanningInfo;

  // Timestamps
  lastActivity?: string;
  scannedAt: string;
}

export interface GsdPlanningInfo {
  projectName?: string;
  description?: string;
  status?: string;
  milestone?: string;
  completedPhases: number;
  totalPhases: number;
  stoppedAt?: string;
  phases: GsdPhaseEntry[];
}

export interface GsdPhaseEntry {
  number: number;
  name: string;
  file: string;
  status: "completed" | "in-progress" | "pending";
  tokenBudget?: number;
  startedAt?: string;
  endedAt?: string;
  costUsd?: number;
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
  // Liveness ground-truth from `claude agents --json` (v2.1.145+).
  // `isLive === true`  — CLI confirms the process is alive.
  // `isLive === false` — CLI ran and did NOT see this session (process exited).
  // `isLive === undefined` — CLI unavailable; treat liveness as unknown.
  pid?: number;
  isLive?: boolean;
  processStartedAt?: string;
  processName?: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

/**
 * Seed-generator candidate. A proposed memory file that hasn't been written
 * yet -- the user inspects + promotes (or skips) on /memory/seed.
 *
 * `targetProjectPath` is required at promote time so the writer knows which
 * memoryDirFor(...) to use. Per-project candidates carry it from the
 * generator; user-scope candidates have it as `null` until the user picks an
 * anchor project on the seed page.
 */
/** Per-row choice on /memory/seed. Drives the POST payload filter. */
export type SeedAction = "skip" | "create" | "overwrite";

export interface SeedCandidate {
  /** Basename with required typed prefix, e.g. "user_role.md". */
  fileName: string;
  type: MemoryType;
  /** "user" = needs an anchor project; "per-project" = auto-routed. */
  scope: "user" | "per-project";
  /** Pre-composed file content (frontmatter + body, ready to write). */
  body: string;
  /** First ~200 chars for inline preview, frontmatter stripped. */
  preview: string;
  /** Human-readable derivation trail, e.g. ["C:\\dev\\foo\\CLAUDE.md", "ProjectData(foo)"]. */
  provenance: string[];
  /** Per-project: set by generator. User-scope: null until anchor chosen. */
  targetProjectPath: string | null;
  /** Set when this candidate's filename already exists on disk. */
  conflict?: {
    existingPath: string;
    existingBody: string;
    /** True when the existing file carries the seed generator's marker. */
    existingIsSeeded: boolean;
  };
}

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

export type MemoryScope = "user" | "project" | "auto";

export interface MemoryStaleness {
  ageOver30d: boolean;
  brokenImports: string[]; // unresolved @import specs (from expandImports)
  /**
   * Candidate file refs extracted from the memory body (e.g. `src/lib/foo.ts`,
   * `~/.claude/CLAUDE.md`) that don't resolve to a real file under either the
   * parent project's tree or any other scanned project. Distinct from
   * brokenImports — that's the structured `@import` directive; this is
   * free-prose path mentions.
   */
  brokenRefs: string[];
}

export interface MemoryFileEntry {
  /** base64url(absPath) — opaque, path-traversal safe identifier. */
  id: string;
  scope: MemoryScope;
  /** Project slug for `project` + `auto` scopes; undefined for `user`. */
  projectSlug?: string;
  /** Project name for display alongside slug; undefined for `user`. */
  projectName?: string;
  absPath: string;
  /** Display name — basename for project/auto, "User CLAUDE.md" for user. */
  displayName: string;
  mtimeMs: number;
  sizeBytes: number;
  /** First ~200 chars of body, frontmatter stripped. */
  preview: string;
  stale: MemoryStaleness;
  /**
   * For `auto` scope only: true if this file is referenced by the project's
   * MEMORY.md index. `undefined` for user/project scope (no index concept) and
   * for auto-scope rows when MEMORY.md is missing entirely.
   */
  indexed?: boolean;
  /**
   * Read telemetry derived from session JSONL replay. `undefined` when the
   * tracker hasn't been refreshed yet, or when this file has no recorded
   * reads. `readCount` is the lifetime count of `Read({file_path})` events
   * Claude Code emitted against this path; `lastReadAt` is the ISO 8601
   * timestamp of the most recent one.
   */
  usage?: {
    readCount: number;
    lastReadAt: string;
  };
}

/** Single bullet-link entry parsed out of a MEMORY.md index. */
export interface MemoryIndexEntry {
  title: string;
  /** Raw href as written in the markdown link (basename of a body file). */
  target: string;
  /** Free-text hook (em-dash side of `- [t](f.md) — hook`). */
  hook: string;
}

/**
 * Per-project rollup of MEMORY.md index state. One per project that has a
 * memory dir; consumed by the `/memory` summary banner and budget chips.
 */
export interface MemoryIndexSummary {
  projectSlug: string;
  projectName: string;
  /** True if MEMORY.md exists in this project's memory dir. */
  present: boolean;
  /** Line count of MEMORY.md (trailing blanks ignored). */
  lineCount: number;
  /** Number of valid bullet-link entries parsed out of the index. */
  entryCount: number;
  /** Body files in the dir not referenced from MEMORY.md. */
  orphans: string[];
  /** Index entries whose target file doesn't exist in the dir. */
  dangling: string[];
  /** Lowercased basenames the index actually points at (debug/audit). */
  linkedNames: string[];
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
  /** Managed-DB provider inferred from the connection host (e.g. "Neon",
   *  "PlanetScale", "Supabase"); undefined for self-hosted/unknown hosts. */
  provider?: string;
}

export interface GitInfo {
  branch: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isDirty: boolean;
  uncommittedCount: number;
  remoteUrl?: string;
}

// ── GitHub activity (Portfolio Command Deck — Phase 4) ──────────────────────
// Surfaced per project from the local authenticated `gh` CLI by
// `githubActivityCache` and served over GET /api/github-activity. Fully
// defensive: a missing/unauthenticated `gh`, a non-GitHub remote, or a
// non-repo directory degrades to `available:false` with a `reason` so the UI
// can stay quiet instead of erroring.

export type GithubActivityReason =
  | "gh-not-installed"      // execFile ENOENT
  | "unauthenticated"       // gh exited with an auth error
  | "not-a-github-repo"     // remote isn't github.com (decided before spawning gh)
  | "no-remote"             // no origin remote at all
  | "error";                // any other gh/parse failure

export type GithubCiStatus = "passing" | "failing" | "pending" | "unknown";

export interface GithubPrSummary {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  updatedAt: string;        // ISO
}

export interface GithubActivity {
  available: boolean;       // false ⇒ render nothing; `reason` says why
  reason?: GithubActivityReason;
  repo?: string;            // "owner/repo" when resolvable
  openPrCount?: number;
  prs?: GithubPrSummary[];  // capped (PR_LIMIT)
  ci?: { status: GithubCiStatus; workflowName?: string; url?: string };
  lastPushAt?: string;      // ISO — repo.pushedAt
  checkedAt: number;        // epoch ms — drives TTL (set even when available:false)
}

export type AuditFindingSeverity = "P0" | "P1" | "P2";

export type ClaudeMdAuditCode =
  | "no-claude-md"
  | "long-index"
  | "file-size"
  | "inline-bloat"
  | "missing-topic-files"
  | "rules-volume"
  | "reference-tiering";

export interface ClaudeMdAuditFinding {
  code: ClaudeMdAuditCode;
  severity: AuditFindingSeverity;
  title: string;
  fix: string;
  penalty: number;
  file?: string;
}

/** Audit result for the absent-CLAUDE.md case. Carries only the
 *  discriminant + a single P1 finding so consumers don't have to
 *  branch on `hasClaudeMd ? presentFields : zeroFields`. */
export interface ClaudeMdAuditAbsent {
  hasClaudeMd: false;
  findings: ClaudeMdAuditFinding[];
}

/** Audit result for the present-CLAUDE.md case. Carries the full
 *  measurement shape (score, line counts, etc.) — TypeScript narrows
 *  on `hasClaudeMd === true` so callers get all fields without `!`. */
export interface ClaudeMdAuditPresent {
  hasClaudeMd: true;
  score: number;            // 0-100, 100 = healthy
  projectLines: number;     // project CLAUDE.md only (post @import-expand) — what `long-index` trips on
  importCount: number;
  fileBytes: number;
  rulesLines: number;
  rulesFileCount: number;
  findings: ClaudeMdAuditFinding[];
}

/** Discriminated union — switch on `hasClaudeMd` to access measurement
 *  fields without optional-chaining. The scanner always produces one
 *  of these two variants (no `undefined` case). */
export type ClaudeMdAuditInfo = ClaudeMdAuditAbsent | ClaudeMdAuditPresent;

// ---------------------------------------------------------------------------
// Config Lint — workspace-wide surface audit
// ---------------------------------------------------------------------------

/** Claude Code config surface being linted. */
export type LintTarget =
  | "claude-md"
  | "skill"
  | "agent"
  | "command"
  | "settings"
  | "hook"
  | "mcp"
  | "plugin"
  | "output-style"
  | "lsp";

/** Which engine produced a finding. */
export type LintEngine = "adapter" | "library" | "vendored";

/** A single config-lint finding. Compatible with `AuditFindingSeverity` so
 *  existing severity-tone UI helpers work without changes. */
export interface LintFinding {
  target: LintTarget;
  /** Namespaced rule code, e.g. "claude-md/long-index", "skill/missing-frontmatter". */
  code: string;
  severity: AuditFindingSeverity;
  title: string;
  fix: string;
  /** Penalty weight preserved verbatim from the source finding (0 for informational). */
  penalty: number;
  engine: LintEngine;
  file?: string;
  docsUrl?: string;
}

export interface LintReport {
  findings: LintFinding[];
  countsByTarget: Partial<Record<LintTarget, { P0: number; P1: number; P2: number }>>;
  totalCounts: { P0: number; P1: number; P2: number };
  engineErrors: { engine: LintEngine; target?: LintTarget; message: string }[];
  /** Strict-gate signal: `true` when any P0 or P1 finding exists. This is the
   *  one authoritative definition of "the config fails strict lint" — a CI
   *  badge or `?tab=config-lint` deep link renders fail-state on this flag
   *  rather than re-deriving the P0/P1 rule in each consumer. Derivable from
   *  `totalCounts`, but materialized so the contract lives in exactly one
   *  place (computed in `buildReport`) and rides along in API/MCP responses. */
  hasBlocking: boolean;
}

// ---------------------------------------------------------------------------
// Config formatter — wraps `claudelint format` (markdownlint + prettier)
// ---------------------------------------------------------------------------

/** Per-file outcome of an apply-mode format run. */
export interface FormatFileResult {
  /** Project-relative path, as the formatter reports it. */
  file: string;
  /** Backup id captured before the rewrite, or `null` when snapshotting
   *  failed (the fix still proceeds — a missing backup never blocks apply)
   *  or the file turned out unchanged (its snapshot is rolled back). */
  backupId: string | null;
  /** True when the on-disk bytes actually changed. */
  changed: boolean;
}

/** Non-mutating "what would change" result. */
export interface FormatCheckResult {
  mode: "check";
  /** Project-relative paths the formatter would rewrite. Empty = clean. */
  filesNeedingFormat: string[];
  /** Populated when the CLI could not be run (spawn/timeout); files is []. */
  engineError?: string;
}

/** Result of an apply-mode run that snapshotted then rewrote files. */
export interface FormatApplyResult {
  mode: "apply";
  formatted: FormatFileResult[];
  engineError?: string;
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
  note?: string;          // entry-level note under the header (e.g. `> archived YYYY-MM-DD — why`)
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

// ── Board (BOARD.md — epics → issues) ──────────────────────────────────────
// Roadmap §6.4 hierarchical model. Parsed by src/lib/scanner/boardMd.ts and
// carried on ProjectData.board. Stable IDs (^e-/^i-) are random base36
// surrogate keys assigned by the writer, NOT content hashes — they must survive
// title edits and reorders so the index keys the same item across mutations.
export type BoardStatus =
  | "backlog"
  | "todo"
  | "doing"
  | "review"
  | "done"
  | "triage";
export type BoardPriority = "high" | "med" | "low";

export interface BoardIssue {
  id: string;                 // "i-xxxx" ("" until the writer backfills it)
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  epicId?: string;            // undefined for Inbox items
  worktree?: string;          // @wt:<branch> provenance
  sessionId?: string;         // ~session:<id> provenance
  detail?: string;            // indented detail lines, newline-joined
  line: number;               // 1-based source line, for write-back
  order: number;              // 0-based position within its container
}

export interface BoardEpic {
  id: string;                 // "e-xxxx" ("" until the writer backfills it)
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  description?: string;       // leading `>` blockquote, newline-joined
  line: number;
  order: number;
  issues: BoardIssue[];
}

export interface BoardInfo {
  epics: BoardEpic[];
  inbox: BoardIssue[];        // items under `## Inbox`
  total: number;              // epics + all epic issues + inbox issues
}

// ── OPERATIONS.md runbook (curated operational facts, living-checklist) ──────
// The ~30% of operational truth that can't be auto-detected: backups,
// monitoring/alerting, on-call/escalation, secrets/rotation, restore. Parsed
// from OPERATIONS.md and surfaced (alongside auto-detected ops) in the per-
// project Operations panel.

/** The five known runbook sections (mapped from `##` headings by a synonym
 *  table); unrecognized headings pass through as `other` so hand-written
 *  runbooks aren't silently dropped. */
export type OpsSectionKey =
  | "backups"
  | "monitoring"
  | "oncall"
  | "secrets"
  | "restore"
  | "other";

export interface OpsRunbookItem {
  text: string;
  done: boolean;        // `- [x]` vs `- [ ]` (recorded, not toggled in v1)
  details: string[];    // indented continuation lines
  lineNumber: number;   // 1-based, for a future writer
}

export interface OpsRunbookSection {
  key: OpsSectionKey;
  heading: string;      // verbatim `## ` heading text
  body: string;         // prose under the heading (non-checkbox lines)
  items: OpsRunbookItem[];
  line: number;         // 1-based heading line
}

export interface OperationsInfo {
  sections: OpsRunbookSection[];
  totalItems: number;
  pendingItems: number;
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
  | "liveActivity"
  | "taskDispatcher"
  | "mcpSecurityScan"
  | "gsdPlanning"
  | "agentView"
  | "claudeStatusAlerts"
  | "configLint"
  | "scanBoard"
  | "scanOps"
  | "githubActivity"
  | "rscHydration"
  | "serverActions";

/** Claude Code lifecycle hook event names sent in the hook stdin payload. */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd";

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
  /** Telegram bridge config. Bot token is stored in secrets.json, not here. Wave 7 (P) honors. */
  telegram?: { chatId?: string };
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
  sessions?: import("@/lib/usage/sessionScatter").SessionScatterPoint[];
  configLint?: {
    totalFindings: number;
    projectsWithFindings: number;
    bySeverity: { P0: number; P1: number; P2: number };
    byTarget: Partial<Record<LintTarget, number>>;
  };
  /**
   * Cross-check of our computed totals against Claude Code's own
   * `stats-cache.json`. Diagnostic only — a large drift means our parser
   * disagrees with Claude's bookkeeping. See `src/lib/scanner/claudeStats.ts`.
   */
  crossCheck?: import("./scanner/claudeStats").StatsCrossCheck;
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
  /**
   * `cache_read / (cache_read + cache_create)` across assistant turns,
   * in [0, 1]. Undefined when the session has no cache activity at all.
   * Populated by both file-parse and DB-ingest paths so the SessionsBrowser
   * cache-hit chip renders identically regardless of backend.
   */
  cacheHitRatio?: number;
  /**
   * Peak `input_tokens / context_window` across assistant turns, in
   * [0, 1]. Undefined when no assistant turn carried `input_tokens`.
   * Used by SessionsBrowser to flag near-compaction sessions and by the
   * Diagnosis panel header.
   */
  maxContextFill?: number;
  /**
   * Quality flags from `sessionQuality` detectors (#102 / #104). True
   * means at least one finding existed at the last ingest/scan.
   * Surfaced as chips on session rows.
   */
  hasCompactionLoop?: boolean;
  hasToolFailureStreak?: boolean;
  hasThinking?: boolean;
  cliVersion?: string;
  hasResumeAnomaly?: boolean;
  compactBoundaryCount?: number;
  /** LLM-generated concise title (Wave 7.1). Stored in `sessions.generated_title`. */
  generatedTitle?: string;
  /** ISO8601 timestamp when this session was starred, or undefined if not starred. */
  starredAt?: string;
  /** ISO8601 timestamp when distillation was last run. */
  distilledAt?: string;
  /** LLM-generated distillation of the session (Wave 7.1b). */
  distilledText?: string;
  /** Work-mode distribution across categorized turns (integer percentages summing to 100). */
  workMode?: { exploration: number; building: number; testing: number; other: number };
  /** True when this session came from a Claude Code worktree directory. */
  isWorktree?: boolean;
  /** Adapter source id (e.g. "claude", "codex"). Defaults to "claude" for legacy sessions. */
  source?: string;
  /**
   * PRs created during this session, harvested from `gh pr create`
   * tool_result text and matched by `tool_use_id` (T2.2). Empty/absent
   * for sessions that never invoked `gh pr create`. Multiple entries
   * possible when a single session opens several PRs; deduped by URL.
   */
  prs?: PrLink[];
  /**
   * Issue/ticket trackers referenced anywhere in this session — harvested
   * by scanning every text block (prompts, assistant text, tool results)
   * for full Linear/Jira/GitHub-issue URLs and deduping by URL (T-item3).
   * "Referenced", not "created": a ticket link is meaningful wherever it
   * appears, so unlike `prs` there is no `gh … create` command pairing.
   * Empty/absent for sessions that never mention a tracker URL.
   */
  tickets?: TicketLink[];
}

/**
 * GitHub PR opened during a Claude Code session, harvested from the
 * `gh pr create` tool_result text. `repo` is derived from the URL, not
 * from the session's git remote — a session may open PRs against a fork
 * or a sibling repo.
 */
export interface PrLink {
  url: string;
  number: number;
  repo: string;
}

/** Issue-tracker providers we can recognize from a verbatim URL. */
export type TicketProvider = "linear" | "jira" | "github";

/**
 * An issue/ticket referenced during a session, parsed from a full URL.
 * `key` is the human-facing identifier shown on the chip:
 *   - linear / jira → the issue key, e.g. "ENG-123"
 *   - github        → "owner/repo#42"
 * `url` is the canonical link (slug/anchor/query stripped) and is the
 * dedup + lookup key (the `?ticket=` filter matches it exactly).
 */
export interface TicketLink {
  provider: TicketProvider;
  key: string;
  url: string;
}

export interface TimelineEvent {
  type: "user" | "assistant" | "tool_use" | "thinking" | "error";
  timestamp?: string;
  content: string;
  toolName?: string;
  tokenCount?: number;
  durationMs?: number;
  /** DB-path turn index; used to lazy-fetch thinking content on expand. */
  turnIndex?: number;
  /** Raw tool arguments for expand-in-place inspection (#231). */
  toolInput?: Record<string, unknown>;
  /** Stable ID linking this event to its tool_result counterpart. */
  toolUseId?: string;
}

export interface FileOperation {
  path: string;
  operation: string;
  timestamp?: string;
  toolName: string;
}

export type SubagentCategory =
  | "fix"
  | "query"
  | "research"
  | "find"
  | "check"
  | "create"
  | "other";

export interface SubagentInfo {
  agentId: string;
  type: string;
  description: string;
  messageCount: number;
  toolUsage: Record<string, number>;
  category?: SubagentCategory;
  metaTurnCount?: number;
  metaSourced?: boolean;
  // Per-invocation runtime metrics, populated by `enrichSubagentsFromOtel`
  // from OTEL `subagent_completed` (model, duration, total_tokens) joined
  // with `api_request` events by `prompt.id` for exact cost + I/O split.
  // Both file-parse (`scanSessionDetail`) and DB-backed
  // (`loadSessionDetailFromDb`) paths run the enrichment. Fields stay
  // undefined when the session has no OTEL coverage (older Claude Code,
  // no telemetry exporter) or the SQLite driver isn't loaded.
  //
  // `costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, and
  // `cacheCreateTokens` are populated only when `api_request` rows exist
  // for the matching `prompt.id`. When only the rollup `subagent_completed`
  // event is available (no api_request join), `totalTokens` carries
  // input+output combined (no I/O split, no cost — can't be priced).
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  model?: string;
  durationMs?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface SessionDetail extends SessionSummary {
  timeline: TimelineEvent[];
  fileOperations: FileOperation[];
  subagents: SubagentInfo[];
  /**
   * Rich per-session metadata from Claude Code's own
   * `~/.claude/usage-data/session-meta/<id>.json` (git activity, lines
   * changed, tool-error categories, …). Absent when no record exists.
   * Read-only enrichment — see `src/lib/scanner/claudeStats.ts`.
   */
  sessionMeta?: import("./scanner/claudeStats").SessionMeta;
}

// ─── Claude config: hooks, MCP servers, plugins ──────────────────────────────

export type HookSource = "project" | "local" | "user" | "plugin";

// `satisfies Record<HookSource, ...>` is the compile-time prompt — adding a
// new HookSource member without extending this table is a type error. The
// inline string checks `s === "user"` we replaced silently returned false
// for new members; this table refuses to compile until you decide.
//
//   - toggleable:    round-trips via the sidecar (~/.claude/.minder/disabled-hooks.json)
//   - projectShared: git-tracked, can't be safely mutated from the dashboard
//                    (hooks are additive — see effectiveConfig.ts:106)
//
// `plugin` is owned by the plugin author and intentionally inert in both flags.
const HOOK_SOURCE_FLAGS = {
  project: { toggleable: false, projectShared: true },
  local:   { toggleable: true,  projectShared: false },
  user:    { toggleable: true,  projectShared: false },
  plugin:  { toggleable: false, projectShared: false },
} as const satisfies Record<HookSource, { toggleable: boolean; projectShared: boolean }>;

export function isToggleableHookSource(s: HookSource): s is "user" | "local" {
  return HOOK_SOURCE_FLAGS[s].toggleable;
}
export function isProjectSharedHookSource(s: HookSource): s is "project" {
  return HOOK_SOURCE_FLAGS[s].projectShared;
}

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
  /** True when this server appears in `disabledMcpjsonServers` in the project's settings files. */
  disabled?: boolean;
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

export interface OutputStyleEntry {
  /** Directory name under `.claude/output-styles/`. */
  name: string;
  /** Absolute path to the style's prompt markdown file. */
  promptPath: string;
  frontmatter: Record<string, unknown>;
}

export interface OutputStylesInfo {
  styles: OutputStyleEntry[];
}

export interface LspConfigInfo {
  /** Absolute path to the lsp.json file. */
  sourcePath: string;
  /** Raw parsed config — keys are language IDs, values are server configs. */
  config: Record<string, unknown>;
}

// ─── Plans ───────────────────────────────────────────────────────────────────

export interface PlanEntry {
  /** Filename without .md extension — stable identifier. */
  slug: string;
  /** Absolute path to the plan file. */
  path: string;
  /** Title from front-matter `title:` or first `# ` heading, else the slug. */
  title: string;
  /** Tags from front-matter `tags:` array. Empty when absent. */
  tags: string[];
  /** Session UUIDs found by regex in the plan body (heuristic). */
  relatedSessionIds: string[];
  mtime: string;
  sizeBytes: number;
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

// ── Operations summary (derive-and-present layer over already-scanned fields) ─
// Composed by `deriveOpsSummary` (src/lib/ops/summary.ts) from fields Minder
// already populates — no new scanning. Serializable so the Operations panel can
// derive it client-side from the /api/projects payload.

export interface OpsCron {
  schedule: string;                 // raw cron expr
  path?: string;                    // vercel cron route, if any
  source: "vercel" | "workflow";
  sourcePath: string;
}

export interface OpsSummary {
  deployTargets: HostingTarget[];   // from CiCdInfo.hosting
  services: string[];               // from ProjectData.externalServices
  database?: DatabaseInfo;          // from ProjectData.database
  crons: OpsCron[];                 // vercelCrons + workflow schedule crons
  dependabot: DependabotUpdate[];   // from CiCdInfo.dependabot
  runbook?: OperationsInfo;         // from OPERATIONS.md; undefined when scanOps off / absent
  /** Honest auto-vs-curated coverage for the "fill your runbook" nudge. */
  coverage: { autoGroups: number; curatedSections: number; curatedTotal: 5 };
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
  /** Findings from the one-shot global catalog lint (user + plugin-scope entries). */
  catalogLintFindings: LintFinding[];
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
  | { kind: "library"; libraryId: string }
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
  bundle?: { rootName: string; files: string[]; totalBytes?: number };
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
  provenance?: import("./indexer/types").Provenance;
  parseWarnings?: string[];
}

// ─── MCP security scanner types ─────────────────────────────────────────────

export type McpFindingSeverity = "crit" | "high" | "med" | "low" | "info";
export type McpFindingCategory =
  | "PI" // prompt injection
  | "CH" // credential harvesting
  | "TP" // tool poisoning
  | "CE" // covert exfiltration
  | "DE" // deobfuscation evasion
  | "SF" // shell feature abuse
  | "HK" // hook / keylogger
  | "TS" // dynamic code execution (TypeScript/JS)
  | "CI" // command injection
  | "PE" // path escape / traversal
  | "EP" // exfiltration param
  | "SC" // sandbox circumvention
  | "XR"; // cross-server / lateral movement

export type McpFindingSurface =
  | "command"
  | "args"
  | "url"
  | "env"
  | "name"
  | "tool-desc"
  | "param-name";

export interface McpFinding {
  id?: number;
  runId: number;
  serverId: string;
  scope: "user" | "project";
  projectSlug?: string;
  ruleId: string;
  category: McpFindingCategory;
  severity: McpFindingSeverity;
  surface: McpFindingSurface;
  surfaceRef?: string;
  message: string;
  evidence?: string;
  foundAtMs: number;
}

export interface McpScanRun {
  id?: number;
  startedAtMs: number;
  durationMs: number;
  serversScanned: number;
  findingsCount: number;
  trigger: "scan" | "manual" | "startup";
}

export interface McpToolFingerprint {
  serverId: string;
  toolName: string;
  descriptionHash: string;
  firstSeenMs: number;
  lastSeenMs: number;
}
