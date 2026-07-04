import type { LintTarget } from "./lint";

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
  crossCheck?: import("../scanner/claudeStats").StatsCrossCheck;
}
