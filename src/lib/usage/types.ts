export interface ToolCall {
  name: string;
  arguments?: Record<string, any>;
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

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheWriteCostPerToken: number;
  cacheReadCostPerToken: number;
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
}

export interface AgentStats {
  name: string;
  invocations: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Record<string, number>;
  sessions: string[];
}

export interface SkillStats {
  name: string;
  invocations: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Record<string, number>;
  sessions: string[];
}

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
  shellStats: ShellStats[];
  mcpStats: McpServerStats[];
  projectDetails: ProjectDetail[];
  generatedAt: string;
}
