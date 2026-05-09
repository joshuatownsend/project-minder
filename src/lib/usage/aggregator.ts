import { parseAllSessions } from "./parser";
import { classifyTurn } from "./classifier";
import { computeToolTransitions } from "./toolTransitions";
import { computeTurnCost, loadPricing } from "./costCalculator";
import { groupByBinary, extractBashCommands } from "./shellParser";
import { groupMcpCalls } from "./mcpParser";
import { detectOneShot } from "./oneShotDetector";
import { getPeriodStart } from "./periods";
import { detectSelfCorrectionPerModel } from "./selfCorrection";
import { bucketByHourDay, type ActivityData } from "./activityBuckets";
import { computeStreaks } from "./streaks";
import { computeContributionCalendar } from "./contributionCalendar";
import { computeProjectYield } from "./computeProjectYield";
import { gatherProjectTurns, encodeProjectPath } from "./projectMatch";
import { getCachedScan } from "@/lib/cache";
import { getAdapterDisplayNameMap } from "@/lib/adapters";
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
  PortfolioYield,
  SourceBreakdown,
} from "./types";

type Period = "today" | "week" | "month" | "all";

export async function generateUsageReport(
  period: Period,
  project?: string
): Promise<UsageReport> {
  const sessionMap = await parseAllSessions();

  let turns: UsageTurn[] = [];
  for (const sessionTurns of sessionMap.values()) {
    turns.push(...sessionTurns);
  }

  // Project filter first (before period) — activity aggregates are project-scoped
  // but use full history (not period-filtered).
  if (project) {
    turns = turns.filter((t) => t.projectSlug === project);
  }

  const assistantTurnsFullHistory = turns.filter((t) => t.role === "assistant");
  const activity: ActivityData = {
    ...bucketByHourDay(assistantTurnsFullHistory),
    streak: computeStreaks(assistantTurnsFullHistory),
    contributionCalendar: computeContributionCalendar(assistantTurnsFullHistory),
  };

  const periodStart = getPeriodStart(period);
  if (periodStart !== null) {
    turns = turns.filter((t) => new Date(t.timestamp) >= periodStart);
  }

  const report = await aggregateUsage(turns, period, activity);

  // Augment with portfolio yield — uses getCachedScan() (no fresh scan
  // triggered) so this is a no-op when the dashboard hasn't loaded yet.
  if (!project) {
    await augmentPortfolioYield(report);
  }

  return report;
}

/**
 * Augment a UsageReport with portfolio-level yield data in-place.
 * Exported so the DB-backed path in `data/index.ts` can call it after
 * loading the SQL report — the augmentation is identical regardless of
 * which backend produced the base report.
 *
 * Calls parseAllSessions() internally (mtime-keyed FileCache; cold call
 * sweeps ~/.claude/projects/). On the file-parse path the cache is already
 * warm; on the DB path it adds one sweep per cold cache hit.
 *
 * Yield is computed from full session history regardless of the report's
 * period filter — by design, matching the Activity section. Yield is a
 * long-term productivity signal, not a point-in-time metric.
 *
 * No-ops when getCachedScan() returns null (scan cache cold) or when
 * the report has no project details.
 */
export async function augmentPortfolioYield(report: UsageReport): Promise<void> {
  const scan = getCachedScan();
  if (!scan || report.projectDetails.length === 0) return;

  const sessionMap = await parseAllSessions();
  // Key by encoded path (e.g. "C--dev-project-minder") so it matches
  // pd.projectDirName from the usage parser, not the scanner's short slug.
  const projectPathMap = new Map(scan.projects.map((p) => [encodeProjectPath(p.path), p.path]));

  // Run in batches of 5 to avoid spawning too many concurrent git processes
  // on large portfolios (each computeProjectYield runs git log per project).
  const YIELD_BATCH = 5;
  type YieldResult = { detail: ProjectDetail; result: Awaited<ReturnType<typeof computeProjectYield>> } | null;
  const results: YieldResult[] = [];
  for (let i = 0; i < report.projectDetails.length; i += YIELD_BATCH) {
    const batch = report.projectDetails.slice(i, i + YIELD_BATCH);
    const batchResults = await Promise.all(
      batch.map(async (pd) => {
        const path = projectPathMap.get(pd.projectDirName);
        if (!path) return null;
        const projectTurns = gatherProjectTurns(sessionMap, pd.projectSlug, path);
        try {
          const result = await computeProjectYield(path, projectTurns);
          return { detail: pd, result };
        } catch {
          return null;
        }
      })
    );
    results.push(...batchResults);
  }

  let totalSessions = 0;
  let productive = 0;
  let reverted = 0;
  let abandoned = 0;

  for (const r of results) {
    if (!r || r.result.kind !== "ok") continue;
    const yr = r.result.report;
    r.detail.yield = yr;
    totalSessions += yr.totalSessions;
    productive += yr.productive;
    reverted += yr.reverted;
    abandoned += yr.abandoned;
  }

  if (totalSessions > 0) {
    const portfolioYield: PortfolioYield = {
      totalSessions,
      productive,
      reverted,
      abandoned,
      yieldRate: productive / totalSessions,
    };
    report.portfolioYield = portfolioYield;
  }
}

/**
 * Pure aggregation over a pre-filtered set of turns. Public so the data
 * façade can hand in turns rehydrated from SQLite (P2b-2) without
 * re-parsing the JSONL corpus. The aggregation logic itself is identical
 * across backends — what changes is only how `turns` was assembled.
 *
 * `activity` carries the five full-history aggregates (hourly, day-of-week,
 * hour×day, streak, contribution calendar). The caller is responsible for
 * computing these from the correct (full-history, project-scoped) turn set
 * before applying the period filter. Use `emptyActivity()` from
 * `activityBuckets.ts` in tests that don't exercise the activity fields.
 */
export async function aggregateUsage(
  turns: UsageTurn[],
  period: Period,
  activity: ActivityData
): Promise<UsageReport> {
  // `loadPricing` is idempotent — first cold call fetches LiteLLM pricing
  // and seeds a 24-h FileCache; subsequent calls return immediately.
  await loadPricing();

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
  const sourceAccum = new Map<string, { cost: number; tokens: number; sessions: Set<string> }>();
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
    }
    bashCommands.push(...extractBashCommands(turn));

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

    // Source
    const src = turn.source ?? "claude";
    {
      const entry = sourceAccum.get(src) ?? { cost: 0, tokens: 0, sessions: new Set<string>() };
      entry.cost += cost;
      entry.tokens += tokens;
      entry.sessions.add(turn.sessionId);
      sourceAccum.set(src, entry);
    }

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

  // Self-correction rate per primary model. The detector groups by
  // sessionId internally and attaches to byModel so the /usage table
  // can render the column without a second join.
  const selfCorrection = detectSelfCorrectionPerModel(turns);
  const selfCorrectionByModel = new Map(
    selfCorrection.byModel.map((s) => [s.model, s] as const)
  );
  for (const m of modelMap.values()) {
    const stats = selfCorrectionByModel.get(m.model);
    if (stats && stats.total > 0) {
      m.selfCorrectionRate = stats.rate;
      m.sessionsAsPrimary = stats.total;
    }
  }

  const toolTransitionData = computeToolTransitions(assistantTurns);

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

  // By-source breakdown (computed from enriched loop data — cost already resolved)
  const adapterDisplayNames = getAdapterDisplayNameMap();
  const bySource: SourceBreakdown[] = [...sourceAccum.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([source, s]) => ({
      source,
      displayName: adapterDisplayNames.get(source) ?? source,
      cost: s.cost,
      tokens: s.tokens,
      sessionCount: s.sessions.size,
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
    toolTransitions: toolTransitionData.transitions,
    toolSelfLoops: toolTransitionData.selfLoops,
    shellStats: groupByBinary(bashCommands),
    mcpStats: groupMcpCalls(allToolCalls),
    projectDetails,
    generatedAt: new Date().toISOString(),
    byHourOfDay: activity.byHourOfDay,
    byDayOfWeek: activity.byDayOfWeek,
    byHourDay: activity.byHourDay,
    streak: activity.streak,
    contributionCalendar: activity.contributionCalendar,
    bySource,
  };
}
