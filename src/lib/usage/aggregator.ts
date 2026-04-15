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
  ProjectDetail,
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
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1);
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
  await loadPricing();

  const sessionMap = await parseAllSessions();

  let turns: UsageTurn[] = [];
  for (const sessionTurns of sessionMap.values()) {
    turns.push(...sessionTurns);
  }

  const periodStart = getPeriodStart(period);
  if (periodStart !== null) {
    turns = turns.filter((t) => new Date(t.timestamp) >= periodStart);
  }
  if (project) {
    turns = turns.filter((t) => t.projectSlug === project);
  }

  // Classify and cost only assistant turns (user turns have empty model/zero tokens)
  const assistantTurns = turns.filter((t) => t.role === "assistant");
  const enriched: { turn: UsageTurn; category: CategoryType; cost: number }[] = [];
  for (const turn of assistantTurns) {
    enriched.push({
      turn,
      category: classifyTurn(turn),
      cost: await computeTurnCost(turn),
    });
  }

  // Single-pass aggregation across all dimensions
  const modelMap = new Map<string, ModelCost>();
  const projectMap = new Map<string, ProjectBreakdown>();
  const categoryMap = new Map<CategoryType, CategoryBreakdown>();
  const categoryTurnsMap = new Map<CategoryType, UsageTurn[]>();
  const dailyMap = new Map<string, DailyBucket>();
  const allToolCalls: ToolCall[] = [];
  const bashCommands: string[] = [];

  // Per-project detail maps for by-project breakdown
  type ProjectDetailAccum = {
    projectSlug: string;
    projectDirName: string;
    cost: number;
    turns: number;
    categoryMap: Map<CategoryType, { cost: number; turns: number }>;
    toolMap: Map<string, number>;
    mcpMap: Map<string, number>; // server -> call count
  };
  const projectDetailAccum = new Map<string, ProjectDetailAccum>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  for (const { turn, category, cost } of enriched) {
    const tokens = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheCreateTokens;

    // Model
    const model = modelMap.get(turn.model) ?? {
      model: turn.model, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, turns: 0,
    };
    model.inputTokens += turn.inputTokens;
    model.outputTokens += turn.outputTokens;
    model.cacheReadTokens += turn.cacheReadTokens;
    model.cacheCreateTokens += turn.cacheCreateTokens;
    model.cost += cost;
    model.turns++;
    modelMap.set(turn.model, model);

    // Project
    const proj = projectMap.get(turn.projectSlug) ?? {
      projectSlug: turn.projectSlug, projectDirName: turn.projectDirName,
      tokens: 0, cost: 0, turns: 0,
    };
    proj.tokens += tokens;
    proj.cost += cost;
    proj.turns++;
    projectMap.set(turn.projectSlug, proj);

    // Category
    const cat = categoryMap.get(category) ?? { category, turns: 0, tokens: 0, cost: 0 };
    cat.turns++;
    cat.tokens += tokens;
    cat.cost += cost;
    categoryMap.set(category, cat);
    const catTurns = categoryTurnsMap.get(category) ?? [];
    catTurns.push(turn);
    categoryTurnsMap.set(category, catTurns);

    // Daily
    const dateStr = turn.timestamp.slice(0, 10);
    const day = dailyMap.get(dateStr) ?? { date: dateStr, cost: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    day.cost += cost;
    day.inputTokens += turn.inputTokens;
    day.outputTokens += turn.outputTokens;
    day.turns++;
    dailyMap.set(dateStr, day);

    // Tools
    for (const tc of turn.toolCalls) {
      allToolCalls.push(tc);
      if ((tc.name === "Bash" || tc.name === "PowerShell") && tc.arguments?.command) {
        bashCommands.push(tc.arguments.command as string);
      }
    }

    // Per-project detail (category + tool + MCP breakdown)
    const detail = projectDetailAccum.get(turn.projectSlug) ?? {
      projectSlug: turn.projectSlug,
      projectDirName: turn.projectDirName,
      cost: 0, turns: 0,
      categoryMap: new Map(),
      toolMap: new Map(),
      mcpMap: new Map(),
    };
    detail.cost += cost;
    detail.turns++;
    const detailCat = detail.categoryMap.get(category) ?? { cost: 0, turns: 0 };
    detailCat.cost += cost;
    detailCat.turns++;
    detail.categoryMap.set(category, detailCat);
    for (const tc of turn.toolCalls) {
      if (tc.name.startsWith("mcp__")) {
        const server = tc.name.split("__")[1] ?? tc.name;
        detail.mcpMap.set(server, (detail.mcpMap.get(server) ?? 0) + 1);
      } else {
        detail.toolMap.set(tc.name, (detail.toolMap.get(tc.name) ?? 0) + 1);
      }
    }
    projectDetailAccum.set(turn.projectSlug, detail);

    // Totals
    totalInput += turn.inputTokens;
    totalOutput += turn.outputTokens;
    totalCacheRead += turn.cacheReadTokens;
    totalCacheWrite += turn.cacheCreateTokens;
  }

  // Per-category one-shot rates
  for (const [cat, catTurns] of categoryTurnsMap.entries()) {
    const stats = detectOneShot(catTurns);
    const breakdown = categoryMap.get(cat);
    if (breakdown && stats.totalVerifiedTasks > 0) {
      breakdown.oneShotRate = stats.oneShotTasks / stats.totalVerifiedTasks;
    }
  }

  // Top tools (non-MCP)
  const toolCounts = new Map<string, number>();
  for (const tc of allToolCalls) {
    if (!tc.name.startsWith("mcp__")) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
    }
  }

  // One-shot aggregate (needs both user+assistant turns for tool result detection)
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

  const cacheHitRate = totalCacheRead + totalInput > 0
    ? totalCacheRead / (totalCacheRead + totalInput) : 0;
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const totalCost = [...modelMap.values()].reduce((s, m) => s + m.cost, 0);

  // Build projectDetails from accumulators
  const projectDetails: ProjectDetail[] = [...projectDetailAccum.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((d) => ({
      projectSlug: d.projectSlug,
      projectDirName: d.projectDirName,
      cost: d.cost,
      turns: d.turns,
      categoryBreakdown: [...d.categoryMap.entries()]
        .map(([category, stats]) => ({ category, ...stats }))
        .sort((a, b) => b.cost - a.cost),
      topTools: [...d.toolMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      mcpServers: [...d.mcpMap.keys()],
      mcpCalls: [...d.mcpMap.values()].reduce((s, n) => s + n, 0),
    }));

  return {
    period,
    totalCost,
    totalTokens,
    totalSessions: new Set(turns.map((t) => t.sessionId)).size,
    totalTurns: assistantTurns.length,
    tokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
    cacheHitRate,
    oneShot: {
      totalVerifiedTasks: totalVerified,
      oneShotTasks: totalOneShot,
      rate: totalVerified > 0 ? totalOneShot / totalVerified : 0,
    },
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...modelMap.values()].sort((a, b) => b.cost - a.cost),
    byProject: [...projectMap.values()].sort((a, b) => b.cost - a.cost),
    byCategory: [...categoryMap.values()].sort((a, b) => b.cost - a.cost),
    topTools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    shellStats: groupByBinary(bashCommands),
    mcpStats: groupMcpCalls(allToolCalls),
    projectDetails,
    generatedAt: new Date().toISOString(),
  };
}
