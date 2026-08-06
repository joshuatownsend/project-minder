import type { AttributionMethod } from "./attribution";

export interface ToolCall {
  name: string;
  id?: string;
  arguments?: Record<string, any>;
  isError?: boolean;
  errorCategory?: string;
  invocationSource?: string;
}

export interface UsageTurn {
  timestamp: string;
  sessionId: string;
  projectSlug: string;
  projectDirName: string;
  model: string;
  role: "user" | "assistant";
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  /**
   * The portion of `cacheCreateTokens` written at the **1-hour** cache TTL,
   * read from `usage.cache_creation.ephemeral_1h_input_tokens`. A subset of
   * `cacheCreateTokens`, never an addition to it — `applyPricing` bills this
   * slice at the 2x rate and the remainder at the 1.25x rate.
   *
   * Undefined when the source turn carries no `cache_creation` breakdown
   * (older transcripts, non-Claude adapters), in which case pricing treats the
   * whole total as 5-minute writes — exactly the pre-split behaviour.
   */
  cacheCreate1hTokens?: number;
  cacheReadTokens: number;
  /**
   * Reasoning effort for this assistant turn (`high` | `medium` | `xhigh`, and
   * `low` per the docs though unobserved locally). Read from the **top level**
   * of the JSONL entry, not from `message`.
   *
   * Undefined on user turns, on transcripts written before the field existed,
   * and on the ~4% of recent assistant turns that lack it. Consumers must keep
   * an explicit unknown bucket: a turn with no `effort` is not a `medium` turn,
   * and averaging over only the turns that have it silently changes the
   * denominator.
   */
  effort?: string;
  /**
   * `standard` | `fast` from `message.usage.speed`. Fast mode bills at roughly
   * double (Opus 5: $10/$50 vs $5/$25), so this is a pricing input, not just a
   * label. Present on every recent assistant turn but **nullable** — null on
   * exactly the turns that also lack `effort` — so null and absent both mean
   * "unknown", never "standard".
   */
  speed?: string;
  /**
   * Session entrypoint (`cli` | `sdk-cli` | `sdk-py`), denormalized onto every
   * turn of the session (A3).
   *
   * Session-constant, so it is redundant per turn — carried here anyway
   * because the file-backend aggregator receives a flat `UsageTurn[]` with no
   * session-level side table, and `byEntrypoint` has to be computable from it.
   * Readers latch it from `attachment` entries; see `entrypoint.ts`.
   */
  entrypoint?: string;
  /**
   * `sessions.session_kind`, in practice only ever `bg` (A3). Absent on 99.9%
   * of sessions — absence means "not flagged as a background run", not
   * "unknown", for any transcript recent enough to emit it at all.
   */
  sessionKind?: string;
  /**
   * Causal cost attribution: which skill / MCP server is responsible for this
   * turn's tokens existing. Distinct from `ToolCall`-level skill and MCP
   * detection, which is *inferred* from the `mcp__server__tool` naming
   * convention and answers "was this call a skill invocation?". Using the
   * inferred value for cost attributes every turn after a tool result to that
   * server, rather than only the turns that consumed it.
   */
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  toolCalls: ToolCall[];
  userMessageText?: string;
  toolResultText?: string;
  /**
   * Extracted assistant text content, sliced to the same per-turn cap as
   * `userMessageText` (500 chars). Only populated on assistant turns.
   * Used by `selfCorrection.ts` to detect correction phrases without
   * re-reading JSONL. Both parser paths populate it identically so the
   * detector behaves the same under MINDER_USE_DB=0/1.
   */
  assistantText?: string;
  isError?: boolean;
  turnDurationMs?: number;
  /**
   * Text of the user prompt that triggered this assistant turn, propagated
   * from the preceding user turn by both parser backends. Assistant turns
   * carry zero `userMessageText` of their own, so intent-based classifier
   * categories (Debugging/Refactoring/Planning/Brainstorming) can only
   * attribute a token-bearing assistant turn's cost when the triggering
   * prompt's text is threaded onto it here. See A3.
   */
  userIntentText?: string;
  /** Set when parsed with includeSidechains:true. Maps to the Task tool_use_id that spawned this sidechain. */
  parentToolUseId?: string;
  /** True when this turn belongs to a sidechain (subagent) session. */
  isSidechain?: boolean;
  /** Adapter source id (e.g. "claude", "codex"). Optional; aggregator coerces absent to "claude". */
  source?: string;
  /** normalizePathKey of the Claude home whose projects tree this turn was
   *  parsed from (multi-home). Disambiguates identically-encoded session dirs
   *  from two distros (e.g. both `-home-josh-dev-x`). Optional — turns from
   *  single-session loaders or older cache entries omit it, and matching
   *  falls back to dirname-only. */
  homeKey?: string;
}

export type CategoryType =
  | "Git Ops"
  | "Build/Deploy"
  | "Testing"
  | "Debugging"
  | "Refactoring"
  | "Delegation"
  | "Planning"
  | "Brainstorming"
  | "Exploration"
  | "Feature Dev"
  | "Coding"
  | "Conversation"
  | "General";

export interface CategoryBreakdown {
  category: CategoryType;
  turns: number;
  tokens: number;
  cost: number;
  oneShotRate?: number;
}

/**
 * Spend and first-pass success rate for one reasoning-effort level (A2).
 *
 * The pairing is the point: cost alone says `xhigh` is expensive, and one-shot
 * rate alone says nothing about what it cost to get there. Together they
 * answer whether raising effort buys a better outcome or just a larger bill.
 *
 * `verifiedTasks` / `oneShotTasks` count *tasks* anchored on turns at this
 * effort, not turns — see `OneShotTask`. They are unrelated to `turns` below
 * and much smaller: most turns never start a verified task.
 */
export interface EffortBreakdown {
  /** `high` | `medium` | `xhigh` | `low`, or `unknown` — see `UNKNOWN_EFFORT`. */
  effort: string;
  turns: number;
  tokens: number;
  cost: number;
  /** Tasks anchored at this effort whose verification produced a verdict. */
  verifiedTasks: number;
  oneShotTasks: number;
  /**
   * `oneShotTasks / verifiedTasks`, or **undefined** when this effort level
   * anchored no verified tasks. Not 0 — a level with no measured tasks has an
   * unknown success rate, and rendering it as 0% ranks it below a level that
   * genuinely failed every time.
   */
  oneShotRate?: number;
}

/**
 * Spend and volume for one session entrypoint (A3).
 *
 * **Session-scoped, unlike every other breakdown on the report.** `byModel`,
 * `byCategory` and `byEffort` roll up turns; `entrypoint` is a property of the
 * session, so `sessions` here is a distinct-session count and `avgCostPerSession`
 * divides by it. Mixing the two scopes is the easy mistake: dividing this
 * bucket's cost by its *turn* count would answer a question nobody asked.
 *
 * The pairing that matters is `sessions` against `cost`. Measured on the index,
 * interactive work is 41% of sessions but 95.8% of spend — so the count
 * distribution, which is what a naive "most of my sessions are automated"
 * reading sees, is actively misleading about where the money goes.
 */
export interface EntrypointBreakdown {
  /** `cli` | `sdk-cli` | `sdk-py`, or `unknown` — see `UNKNOWN_ENTRYPOINT`. */
  entrypoint: string;
  /** Distinct sessions, NOT turns. */
  sessions: number;
  turns: number;
  tokens: number;
  cost: number;
  /**
   * `cost / sessions`. Precomputed rather than left to the caller because both
   * backends must agree on the denominator, and a UI dividing by whichever
   * count is nearest to hand is exactly how the two would drift.
   */
  avgCostPerSession: number;
  /**
   * Sessions in this bucket flagged `session_kind = 'bg'`. A flag, not a
   * sub-bucket: these are already counted in `sessions` above.
   */
  backgroundSessions: number;
}

/**
 * Spend caused by one skill (A4), optionally crossed with first-pass success.
 *
 * Deliberately separate from `tool_uses.skill_name` call counts rather than an
 * extra column on them: the two differ by ~373x on real data and mean different
 * things. See `attribution.ts`.
 *
 * The one-shot fields reuse `turns.task_outcome` (A2) rather than growing a
 * rollup of their own — that column was built as a general turn-level join key
 * for exactly this. It answers a question counts cannot: *which skills produce
 * work that passes verification first time?*
 */
export interface SkillCost {
  skill: string;
  turns: number;
  tokens: number;
  cost: number;
  /** Tasks anchored on turns attributed to this skill. */
  verifiedTasks: number;
  oneShotTasks: number;
  /**
   * `oneShotTasks / verifiedTasks`, or **undefined** when this skill anchored
   * no verified task. Never 0 — see `EffortBreakdown.oneShotRate` for why the
   * two must stay distinguishable.
   */
  oneShotRate?: number;
  /** Which signal produced `cost`. Never mixed within one list. */
  method: AttributionMethod;
}

/**
 * Spend caused by one MCP server (A4).
 *
 * `server` is the display name (the id a user would recognize from their MCP
 * config); `key` is the folded form both signals agree on. They differ because
 * the inferred name is recovered from an already-encoded tool name — see
 * `mcpServerKey`.
 */
export interface McpServerCost {
  /** Display name — the explicit id where available. */
  server: string;
  /** Canonical join key; see `mcpServerKey`. */
  key: string;
  turns: number;
  tokens: number;
  cost: number;
  method: AttributionMethod;
}

export interface ModelCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
  turns: number;
  /**
   * Self-correction rate: correctedSessions / sessionsForModel for
   * sessions whose primary model (most assistant turns) is this one.
   * Range [0, 1]. Undefined when the model has no sessions attributed
   * to it.
   *
   * Caveat: "primary model" is most-turn-wins; a 90%-Opus session whose
   * single corrected turn ran on Haiku still attributes to Opus. The
   * metric tracks first-pass reliability of the model the user ran the
   * session on — not which model emitted the apology phrase.
   */
  selfCorrectionRate?: number;
  /** Number of sessions whose primary model was this one — denominator
   *  for `selfCorrectionRate`. Surfaced for tooltip context. */
  sessionsAsPrimary?: number;
}

export interface ShellStats {
  binary: string;
  count: number;
}

export interface ToolTransition {
  from: string;
  to: string;
  count: number;
}

export interface ToolSelfLoop {
  tool: string;
  count: number;
}

export interface McpServerStats {
  server: string;
  tools: Record<string, number>;
  totalCalls: number;
}

export interface OneShotStats {
  totalVerifiedTasks: number;
  oneShotTasks: number;
  rate: number;
}

export interface DailyBucket {
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface ProjectBreakdown {
  projectSlug: string;
  projectDirName: string;
  /**
   * Normalized key of the Claude home that recorded these turns
   * (`normalizePathKey(home)`), when known. Two configured homes with
   * identical path layouts (Ubuntu + Debian both `/home/josh/dev/foo`)
   * produce the SAME projectSlug — rows are grouped per (slug, home) so
   * their spend stays separable, and the /costs join disambiguates on
   * this field (#311). Absent on rows from turns with no home stamp.
   */
  homeKey?: string;
  tokens: number;
  cost: number;
  turns: number;
}

export interface SourceBreakdown {
  source: string;
  displayName: string;
  cost: number;
  tokens: number;
  sessionCount: number;
}

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /**
   * Rate for cache writes made with the **5-minute** (default) TTL — 1.25x base
   * input. Historically the only cache-write rate Minder modelled, so it keeps
   * the name every existing caller and pricing rule already uses.
   */
  cacheWriteCostPerToken: number;
  cacheReadCostPerToken: number;
  /**
   * Rate for cache writes made with the **1-hour** TTL — 2x base input, from
   * LiteLLM's `cache_creation_input_token_cost_above_1hr`. Claude Code writes
   * its prompt cache at the 1-hour TTL, so on a Claude Code transcript this is
   * the rate that applies to essentially every cache-write token; billing them
   * all at `cacheWriteCostPerToken` understates cache-write cost by ~37%.
   * Absent → `applyPricing` falls back to the 5-minute rate (the pre-split
   * behaviour), which is also correct for providers with a single write rate.
   */
  cacheWrite1hCostPerToken?: number;
  /**
   * Tiered (>200k-context) surcharge rates from LiteLLM's
   * `input_cost_per_token_above_200k_tokens` / `output_cost_per_token_above_200k_tokens`.
   * When present, `applyPricing` bills tokens up to 200k at the base rate and
   * tokens above 200k at this rate. Absent → flat pricing (backward compatible). See A4.
   */
  inputCostPerTokenAbove200k?: number;
  outputCostPerTokenAbove200k?: number;
}

export interface PortfolioYield {
  totalSessions: number;
  productive: number;
  reverted: number;
  abandoned: number;
  /** productive / totalSessions across all projects with yield data. */
  yieldRate: number;
}

export interface ProjectDetail {
  projectSlug: string;
  projectDirName: string;
  cost: number;
  turns: number;
  categoryBreakdown: Array<{ category: CategoryType; cost: number; turns: number }>;
  topTools: [string, number][];
  mcpServers: string[];
  mcpCalls: number;
  /** Yield classification for this project. Populated by augmentPortfolioYield() on both backends. */
  yield?: import("./yieldAnalysis").YieldReport;
}

export interface AgentStats {
  name: string;
  invocations: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Record<string, number>;
  sessions: string[];
  /** Per-agent cost derived from sidechain file-parse (populated on demand). */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SkillStats {
  name: string;
  invocations: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Record<string, number>;
  sessions: string[];
}

export interface ActivityBucket {
  turns: number;
  cost: number;
}

export interface StreakStats {
  currentDays: number;
  longestDays: number;
  lastActiveDate: string | null;
  totalActiveDays: number;
}

export interface ContributionCell {
  date: string;
  turns: number;
  cost: number;
  weekIndex: number;
  dayOfWeek: number;
}

// ── Period-over-period comparison ───────────────────────────────────────────
// Scalar summary of one time window — the lean shape the Compare feature
// diffs. Deliberately mirrors the five StatCells the UsageDashboard already
// renders (cost / tokens / sessions+turns / cache-hit / 1-shot) so a delta is
// shown only on numbers the user already knows, never a metric invented for
// the compare. Computed by `queryPeriodSummary` (two aggregate queries), NOT
// the full `loadUsageReportFromSql` — the full report's streak / calendar /
// heatmap aggregates ignore the period filter and would be identical (and
// meaningless) across both windows.
export interface PeriodSummary {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sessions: number;
  turns: number;
  cacheHitRate: number;
  oneShotRate: number;
  verifiedTasks: number;
  oneShotTasks: number;
}

/** Inclusive-start, exclusive-end ISO bounds of a comparison window. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** One metric's current-vs-previous delta. `pct` is null when `previous` is
 *  0 (the metric is "new" this period — a ratio would be +∞).
 *
 *  `basis` is true when the delta describes a real change. It's always true
 *  for volume metrics (a 0 cost IS a measurement), but a *rate* metric whose
 *  current or previous window measured nothing carries `basis: false` — its
 *  0-fallback rate is absence, not a real 0%. Consumers must render a neutral
 *  placeholder rather than a confident "↓-80pp" when `basis` is false. The
 *  rule lives here, on the data, so every consumer (UI, export, MCP) inherits
 *  it instead of re-deriving it. */
export interface MetricDelta {
  current: number;
  previous: number;
  absolute: number;
  pct: number | null;
  basis: boolean;
}

export interface ComparisonDeltas {
  cost: MetricDelta;
  tokens: MetricDelta;
  sessions: MetricDelta;
  cacheHitRate: MetricDelta;
  oneShotRate: MetricDelta;
}

/**
 * Period-over-period comparison: the current window vs the immediately
 * preceding window of equal elapsed length.
 *
 * A discriminated union on `comparable` so the populated fields exist only
 * when there's something to compare. `comparable: false` carries just the
 * reason — emitted for "all" (no prior window), `MINDER_USE_DB=0`, and the
 * v3-reconcile catch-up window (cost columns not yet populated).
 */
export type UsageComparison =
  | {
      comparable: true;
      period: string;
      current: PeriodSummary;
      previous: PeriodSummary;
      deltas: ComparisonDeltas;
      currentWindow: TimeWindow;
      previousWindow: TimeWindow;
    }
  | {
      comparable: false;
      period: string;
      reason: string;
    };

export interface UsageReport {
  period: string;
  totalCost: number;
  totalTokens: number;
  totalSessions: number;
  totalTurns: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cacheHitRate: number;
  oneShot: OneShotStats;
  daily: DailyBucket[];
  byModel: ModelCost[];
  byProject: ProjectBreakdown[];
  byCategory: CategoryBreakdown[];
  /**
   * Spend and first-pass success by reasoning effort (A2). Sorted by the
   * ordinal effort scale — NOT by cost — with the `unknown` bucket last.
   * Empty on adapter sources that don't record effort. See `effort.ts`.
   */
  byEffort: EffortBreakdown[];
  /**
   * Spend and volume by session entrypoint (A3) — interactive versus
   * SDK-driven. Sorted by {@link ENTRYPOINT_ORDER}, not by cost, so the rows
   * hold their positions between periods. Session-scoped: see
   * {@link EntrypointBreakdown}. See `entrypoint.ts`.
   */
  byEntrypoint: EntrypointBreakdown[];
  /**
   * Spend caused by each skill (A4), crossed with first-pass success. Sorted
   * by cost. Uses Claude Code's explicit `attribution_skill` where present and
   * falls back to inference; `method` says which, and the two are never mixed
   * within one list. See `attribution.ts`.
   */
  bySkillCost: SkillCost[];
  /**
   * Spend caused by each MCP server (A4). Sorted by cost. Distinct from
   * `mcpStats`, which counts CALLS — the two differ by ~11x and answer
   * different questions.
   */
  byMcpCost: McpServerCost[];
  topTools: [string, number][];
  toolTransitions: ToolTransition[];
  toolSelfLoops: ToolSelfLoop[];
  shellStats: ShellStats[];
  mcpStats: McpServerStats[];
  projectDetails: ProjectDetail[];
  generatedAt: string;
  byHourOfDay: ActivityBucket[];
  byDayOfWeek: ActivityBucket[];
  byHourDay: ActivityBucket[][];
  streak: StreakStats;
  contributionCalendar: ContributionCell[];
  /** Portfolio-level yield aggregate. Populated by augmentPortfolioYield() on both backends. */
  portfolioYield?: PortfolioYield;
  bySource: SourceBreakdown[];
  /**
   * Subagent (Task/sidechain) spend broken out of the headline totals. These
   * turns' tokens and cost ARE folded into `totalCost`/`totalTokens`/`byModel`/
   * `byProject`/`daily`/`byCategory`; this pair lets the UI show how much of the
   * total came from subagents. Both backends populate identically. See A1.
   */
  subagentCost: number;
  subagentTokens: number;
}
