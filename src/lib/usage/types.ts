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
  cacheReadTokens: number;
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
  cacheWriteCostPerToken: number;
  cacheReadCostPerToken: number;
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
