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
  sessionMeta?: import("../scanner/claudeStats").SessionMeta;
}
