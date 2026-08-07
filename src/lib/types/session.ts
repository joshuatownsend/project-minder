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

  // ── A1: decoded from Claude Code's newer transcript entry types ───────────
  // All optional and version-dependent. Absence means "this transcript predates
  // the field", which is NOT the same as a default value — every consumer needs
  // an explicit unknown bucket rather than assuming e.g. `medium` effort.

  /**
   * Session flavour from `attachment.sessionKind` — e.g. `bg` for a
   * backgrounded session. Undefined for ordinary interactive sessions and for
   * any transcript written before the field existed, so it cannot be used to
   * prove a session *was* interactive.
   */
  sessionKind?: string;
  /** How the session was launched, from `attachment.entrypoint`: `cli` | `sdk-cli`. */
  entrypoint?: string;
  /**
   * Model-generated session title from a `type: "ai-title"` entry. Distinct
   * from `generatedTitle`, which Minder produces itself (Wave 7.1) — this one
   * comes from Claude Code. Last one wins: the title is re-emitted as a
   * session's subject becomes clearer.
   */
  aiTitle?: string;
  /**
   * Permission-mode timeline from `type: "permission-mode"` entries, in file
   * order. A session that never switched mode has none — absence is not `auto`.
   */
  permissionModes?: SessionPermissionMode[];
  /**
   * Count of assistant turns per reasoning effort, e.g. `{ high: 812, xhigh: 39 }`.
   * Only turns that carried `effort` are counted, so the values need not sum to
   * `assistantMessageCount`; the difference is turns from before the field
   * existed. Empty/absent for a fully pre-`effort` session.
   */
  effortMix?: Record<string, number>;
  /**
   * Hook executions observed in this session, from `hookInfos` on **system**
   * entries. One-to-many per session, so this is a list rather than an
   * aggregate; A6 turns it into latency analytics.
   */
  hookRuns?: SessionHookRun[];
  /** Hook failures reported in this session, from `hookErrors`. */
  hookErrors?: SessionHookError[];
}

/** One permission-mode change within a session. */
export interface SessionPermissionMode {
  /** ISO8601, or undefined — `permission-mode` entries carry no timestamp of their own. */
  ts?: string;
  /** e.g. `auto`, `plan`. Not an enum: Claude Code may add modes. */
  mode: string;
}

/** One hook execution, from a `hookInfos` record on a system entry. */
export interface SessionHookRun {
  ts?: string;
  command: string;
  /**
   * Wall-clock the hook took, when Claude Code measured it.
   *
   * Genuinely optional: 4,189 of 20,284 hook records on the local corpus carry
   * a command and no duration. `undefined` means **not measured**, which must
   * not be rendered as `0` — an unmeasured hook would sort as the fastest one.
   */
  durationMs?: number;
}

/**
 * One hook failure. `hookErrors` is a sibling array of plain strings on the
 * same system entry as `hookInfos`, NOT a field inside each hook record, so an
 * error cannot be attributed to a specific command — recording it per entry is
 * the honest shape rather than guessing which hook produced it.
 */
export interface SessionHookError {
  ts?: string;
  message: string;
  /** True when the failure stopped the turn continuing, rather than being advisory. */
  preventedContinuation: boolean;
}

/**
 * GitHub PR opened during a Claude Code session, harvested from the
 * `gh pr create` tool_result text. `repo` is derived from the URL, not
 * from the session's git remote — a session may open PRs against a fork
 * or a sibling repo.
 */
/** How Minder learned about a PR link. See {@link PrLink.source}. */
export type PrLinkSource = "recorded" | "scraped";

/**
 * Narrow a DB `source` column to the enum, or `undefined`.
 *
 * The column is TEXT, so a hand-edited or future-typo value would otherwise be
 * cast straight through and reach the UI as an invalid `PrLink.source` — where
 * it renders as neither recorded nor scraped and looks like a rendering bug
 * rather than a data one (Copilot review of #385). An unrecognised value is
 * treated exactly like NULL: unknown provenance, which the UI already handles.
 */
export function toPrLinkSource(value: unknown): PrLinkSource | undefined {
  return value === "recorded" || value === "scraped" ? value : undefined;
}

export interface PrLink {
  url: string;
  number: number;
  repo: string;
  /**
   * `recorded` — Claude Code wrote a `type:"pr-link"` entry. URL, number and
   * repository are reported by the CLI rather than parsed out of anything.
   *
   * `scraped` — a PR URL matched by regex in a `gh pr create` tool result.
   * Everything is inferred from command output, including `repo`, which is
   * recovered from the URL itself. A scraped link can be a false positive in a
   * way a recorded one cannot: `gh pr create` answering "a pull request for
   * branch X already exists: <url>" reads exactly like a successful create.
   *
   * `undefined` on rows indexed before the column existed — which does **not**
   * mean scraped.
   */
  source?: PrLinkSource;
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
  /**
   * Turns counted from the transcript — **undefined when the backend cannot
   * count them**, which is the default case.
   *
   * The SQLite path does not index sidechain entries, so it has no count to
   * give (documented divergence #3 in `sessionDetailFromDb.ts`). It used to
   * report `0` for that, which is indistinguishable from a subagent that
   * genuinely took no turns — and comparing that `0` against Claude Code's own
   * `metaTurnCount` presented a backend limitation as a data disagreement
   * (Codex review of #403).
   *
   * The file backend counts for real and always supplies a number.
   */
  messageCount?: number;
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
