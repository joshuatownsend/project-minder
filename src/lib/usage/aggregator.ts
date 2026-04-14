import { parseAllSessions } from "./parser";
import { classifyTurn } from "./classifier";
import { computeTurnCost, loadPricing } from "./costCalculator";
import { groupByBinary } from "./shellParser";
import { groupMcpCalls } from "./mcpParser";
import { detectOneShot } from "./oneShotDetector";
import type {
  UsageTurn,
  UsageReport,
  ModelCost,
  ProjectBreakdown,
  CategoryBreakdown,
  CategoryType,
  DailyBucket,
  ToolCall,
} from "./types";

function getPeriodStart(period: string): Date | null {
  const now = new Date();
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay()); // start of week (Sunday)
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return start;
    }
    case "all":
      return null;
    default:
      return null;
  }
}

export async function generateUsageReport(
  period: "today" | "week" | "month" | "all",
  project?: string
): Promise<UsageReport> {
  // Ensure pricing is loaded before computing costs
  await loadPricing();

  // 1. Parse all sessions
  const sessionMap = await parseAllSessions();

  // 2. Flatten all turns
  let turns: UsageTurn[] = [];
  for (const sessionTurns of sessionMap.values()) {
    turns.push(...sessionTurns);
  }

  // 3. Filter by period
  const periodStart = getPeriodStart(period);
  if (periodStart !== null) {
    turns = turns.filter((t) => new Date(t.timestamp) >= periodStart);
  }

  // 4. Filter by project
  if (project) {
    turns = turns.filter((t) => t.projectSlug === project);
  }

  // 5. Classify each turn
  const classifiedTurns = turns.map((t) => ({ turn: t, category: classifyTurn(t) }));

  // 6. Aggregate by model
  const modelMap = new Map<string, ModelCost>();
  for (const { turn } of classifiedTurns) {
    const cost = await computeTurnCost(turn);
    const existing = modelMap.get(turn.model) ?? {
      model: turn.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      cost: 0,
      turns: 0,
    };
    existing.inputTokens += turn.inputTokens;
    existing.outputTokens += turn.outputTokens;
    existing.cacheReadTokens += turn.cacheReadTokens;
    existing.cacheCreateTokens += turn.cacheCreateTokens;
    existing.cost += cost;
    existing.turns++;
    modelMap.set(turn.model, existing);
  }

  // 7. Aggregate by project
  const projectMap = new Map<string, ProjectBreakdown>();
  for (const { turn } of classifiedTurns) {
    const cost = await computeTurnCost(turn);
    const tokens = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheCreateTokens;
    const existing = projectMap.get(turn.projectSlug) ?? {
      projectSlug: turn.projectSlug,
      projectDirName: turn.projectDirName,
      tokens: 0,
      cost: 0,
      turns: 0,
    };
    existing.tokens += tokens;
    existing.cost += cost;
    existing.turns++;
    projectMap.set(turn.projectSlug, existing);
  }

  // 8. Aggregate by category (including per-category one-shot rates)
  const categoryMap = new Map<CategoryType, CategoryBreakdown>();
  // Group turns by category for one-shot detection
  const categoryTurnsMap = new Map<CategoryType, UsageTurn[]>();
  for (const { turn, category } of classifiedTurns) {
    const cost = await computeTurnCost(turn);
    const tokens = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheCreateTokens;
    const existing = categoryMap.get(category) ?? {
      category,
      turns: 0,
      tokens: 0,
      cost: 0,
    };
    existing.turns++;
    existing.tokens += tokens;
    existing.cost += cost;
    categoryMap.set(category, existing);

    const arr = categoryTurnsMap.get(category) ?? [];
    arr.push(turn);
    categoryTurnsMap.set(category, arr);
  }
  // Compute per-category one-shot rates
  for (const [cat, catTurns] of categoryTurnsMap.entries()) {
    const stats = detectOneShot(catTurns);
    const breakdown = categoryMap.get(cat);
    if (breakdown) {
      breakdown.oneShotRate = stats.totalVerifiedTasks > 0 ? stats.oneShotTasks / stats.totalVerifiedTasks : undefined;
    }
  }

  // 9. Bucket by day
  const dailyMap = new Map<string, DailyBucket>();
  for (const { turn } of classifiedTurns) {
    const cost = await computeTurnCost(turn);
    const dateStr = turn.timestamp.slice(0, 10); // "YYYY-MM-DD"
    const existing = dailyMap.get(dateStr) ?? {
      date: dateStr,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    };
    existing.cost += cost;
    existing.inputTokens += turn.inputTokens;
    existing.outputTokens += turn.outputTokens;
    existing.turns++;
    dailyMap.set(dateStr, existing);
  }

  // 10. Collect all tool calls for tool/shell/MCP stats
  const allToolCalls: ToolCall[] = [];
  const bashCommands: string[] = [];
  for (const { turn } of classifiedTurns) {
    for (const tc of turn.toolCalls) {
      allToolCalls.push(tc);
      if ((tc.name === "Bash" || tc.name === "PowerShell") && tc.arguments?.command) {
        bashCommands.push(tc.arguments.command as string);
      }
    }
  }

  // 11. Top tools (non-MCP, grouped by name)
  const toolCounts = new Map<string, number>();
  for (const tc of allToolCalls) {
    if (!tc.name.startsWith("mcp__")) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
    }
  }
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  // 12. Shell stats
  const shellStats = groupByBinary(bashCommands);

  // 13. MCP stats
  const mcpStats = groupMcpCalls(allToolCalls);

  // 14. One-shot stats (per session, then aggregate)
  let totalVerified = 0;
  let totalOneShot = 0;
  const sessionGroups = new Map<string, UsageTurn[]>();
  for (const t of turns) {
    const arr = sessionGroups.get(t.sessionId) ?? [];
    arr.push(t);
    sessionGroups.set(t.sessionId, arr);
  }
  for (const sessionTurns of sessionGroups.values()) {
    const stats = detectOneShot(sessionTurns);
    totalVerified += stats.totalVerifiedTasks;
    totalOneShot += stats.oneShotTasks;
  }

  // 15. Totals
  const totalInput = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCacheRead = turns.reduce((s, t) => s + t.cacheReadTokens, 0);
  const totalCacheWrite = turns.reduce((s, t) => s + t.cacheCreateTokens, 0);
  const cacheHitRate =
    totalCacheRead + totalInput > 0 ? totalCacheRead / (totalCacheRead + totalInput) : 0;

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const totalCost = [...modelMap.values()].reduce((s, m) => s + m.cost, 0);

  const uniqueSessions = new Set(turns.map((t) => t.sessionId));
  const totalSessions = uniqueSessions.size;

  // 16. Sort results
  const byModel = [...modelMap.values()].sort((a, b) => b.cost - a.cost);
  const byProject = [...projectMap.values()].sort((a, b) => b.cost - a.cost);
  const byCategory = [...categoryMap.values()].sort((a, b) => b.cost - a.cost);
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    period,
    totalCost,
    totalTokens,
    totalSessions,
    totalTurns: turns.length,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
    cacheHitRate,
    oneShot: {
      totalVerifiedTasks: totalVerified,
      oneShotTasks: totalOneShot,
      rate: totalVerified > 0 ? totalOneShot / totalVerified : 0,
    },
    daily,
    byModel,
    byProject,
    byCategory,
    topTools,
    shellStats,
    mcpStats,
    generatedAt: new Date().toISOString(),
  };
}
