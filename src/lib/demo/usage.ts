import type { AggregatorPeriod } from "@/lib/usage/period";
import type { Period } from "@/lib/usage/constants";
import type {
  UsageReport,
  ModelCost,
  CategoryType,
  CategoryBreakdown,
  DailyBucket,
  ProjectBreakdown,
  ProjectDetail,
  ShellStats,
  McpServerStats,
  ToolTransition,
  ToolSelfLoop,
  ActivityBucket,
  ContributionCell,
  SourceBreakdown,
  AgentStats,
  SkillStats,
} from "@/lib/usage/types";
import type { ClaudeUsageStats } from "@/lib/types/stats";
import type {
  UsageResult,
  ClaudeUsageResult,
  AgentUsageResult,
  SkillUsageResult,
} from "@/lib/data";

/**
 * Synthetic token-usage / cost fixtures for demo mode. Deterministic (NO
 * `Math.random()`) and anchored to a `nowMs` passed at request time, so the
 * daily-cost series and relative timestamps stay fresh across runs while the
 * shape is byte-stable for a fixed `nowMs`.
 *
 * These satisfy the return types of the four usage façade functions in
 * `src/lib/data/index.ts` (`getUsage`, `getClaudeUsage`, `getAgentUsage`,
 * `getSkillUsage`) and are meant to be returned from a `demoMode()` guard
 * placed ABOVE the `dbModeRequested()` / `getReadyDb()` branch in each.
 *
 * Costs/tokens are keyed to the eight demo projects (see `demo/projects.ts`)
 * by their usage slug `dev-<slug>`. aurora-commerce is the biggest spender.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Blended billed-tokens per dollar (cache reads dominate the token count). */
const TOKENS_PER_DOLLAR = 92_000;
/** Rough assistant turns per dollar. */
const TURNS_PER_DOLLAR = 5;

/** Per-dollar token split (sums to 1). cacheRead dominates → ~79% cache-hit. */
const TOK = { input: 0.09, output: 0.09, cacheRead: 0.72, cacheCreate: 0.1 };

/** Per-project daily spend weight (USD/day). aurora-commerce is the biggest. */
const WEIGHTS: { slug: string; weight: number }[] = [
  { slug: "aurora-commerce", weight: 36 },
  { slug: "pulse-analytics", weight: 26 },
  { slug: "quill-cms", weight: 20 },
  { slug: "ledger-api", weight: 16 },
  { slug: "atlas-cli", weight: 11 },
  { slug: "beacon-mobile", weight: 9 },
  { slug: "synth-playground", weight: 6 },
  { slug: "archive-legacy-dash", weight: 4 },
];
const WEIGHT_OF = new Map(WEIGHTS.map((w) => [w.slug, w.weight]));
const TOTAL_WEIGHT = WEIGHTS.reduce((s, w) => s + w.weight, 0);

const MODELS: { model: string; frac: number; scr?: number }[] = [
  { model: "claude-opus-4-8", frac: 0.56, scr: 0.12 },
  { model: "claude-sonnet-5", frac: 0.37, scr: 0.07 },
  { model: "claude-haiku-4-5", frac: 0.07 },
];

const CATS: { category: CategoryType; frac: number; osr: number }[] = [
  { category: "Feature Dev", frac: 0.28, osr: 0.71 },
  { category: "Debugging", frac: 0.17, osr: 0.52 },
  { category: "Testing", frac: 0.12, osr: 0.78 },
  { category: "Refactoring", frac: 0.1, osr: 0.64 },
  { category: "Coding", frac: 0.09, osr: 0.69 },
  { category: "Exploration", frac: 0.06, osr: 0.83 },
  { category: "Git Ops", frac: 0.05, osr: 0.9 },
  { category: "Planning", frac: 0.04, osr: 0.6 },
  { category: "Build/Deploy", frac: 0.03, osr: 0.74 },
  { category: "Delegation", frac: 0.025, osr: 0.66 },
  { category: "Brainstorming", frac: 0.015, osr: 0.55 },
  { category: "Conversation", frac: 0.01, osr: 0.88 },
  { category: "General", frac: 0.01, osr: 0.7 },
];

const TOOLS: [string, number][] = [
  ["Read", 0.22],
  ["Edit", 0.16],
  ["Bash", 0.14],
  ["Grep", 0.11],
  ["Glob", 0.07],
  ["Write", 0.06],
  ["TodoWrite", 0.05],
  ["Task", 0.04],
  ["WebFetch", 0.03],
  ["MultiEdit", 0.03],
  ["Read (image)", 0.02],
  ["NotebookEdit", 0.01],
];

const SHELLS: [string, number][] = [
  ["git", 0.3],
  ["pnpm", 0.2],
  ["node", 0.12],
  ["npx", 0.1],
  ["rg", 0.08],
  ["ls", 0.07],
  ["cat", 0.05],
  ["docker", 0.04],
  ["gh", 0.04],
];

/** Which MCP servers each project touches (empty → no MCP for that project). */
const PROJECT_MCP: Record<string, string[]> = {
  "aurora-commerce": ["project-minder", "github"],
  "pulse-analytics": ["project-minder", "github"],
  "ledger-api": ["github"],
  "atlas-cli": ["github"],
};

// Hour-of-day weights (24, sums ≈ 1): night-quiet, work-hours-heavy.
const HOUR_W = [
  0.005, 0.004, 0.003, 0.003, 0.004, 0.008, 0.015, 0.03, 0.05, 0.07, 0.08, 0.08,
  0.07, 0.075, 0.08, 0.08, 0.075, 0.06, 0.05, 0.04, 0.03, 0.02, 0.012, 0.008,
];
// Day-of-week weights (Sun..Sat, sums to 1): weekdays heavier.
const DAY_W = [0.08, 0.17, 0.18, 0.18, 0.16, 0.14, 0.09];

const COST_PER_TURN = 0.22;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Local `YYYY-MM-DD` (matches the aggregator's `toLocalDateStr`). */
function localDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Approximate number of active days a period spans (loose — for scaling). */
function periodDays(p: string): number {
  switch (p) {
    case "today":
    case "24h":
      return 1;
    case "7d":
    case "week":
      return 7;
    case "30d":
    case "month":
      return 30;
    case "90d":
      return 90;
    case "1y":
      return 365;
    case "all":
      return 520;
    default:
      return 30;
  }
}

/** Deterministic per-day spend multiplier (weekends dip; gentle ripple). */
function wave(nowMs: number, k: number): number {
  const dow = new Date(nowMs - k * DAY).getDay();
  const weekend = dow === 0 || dow === 6;
  const w = 1 + 0.18 * Math.sin(k * 0.6) + 0.08 * Math.cos(k * 0.27);
  return Math.max(0.25, weekend ? w * 0.55 : w);
}

function splitTokens(total: number): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  const input = Math.round(total * TOK.input);
  const output = Math.round(total * TOK.output);
  const cacheRead = Math.round(total * TOK.cacheRead);
  const cacheCreate = total - input - output - cacheRead;
  return { input, output, cacheRead, cacheCreate };
}

/**
 * Build a full `UsageReport` over the given set of demo project slugs.
 *
 * `totalCost` is summed over the entire period window (`periodDays`), while the
 * `daily` chart only exposes the last ≤30 days — so `daily` sums to `totalCost`
 * for periods ≤30d and to a recent-window slice for longer periods (matching
 * the real report, where the headline is the period total and the chart is a
 * bounded recent window).
 */
function buildReport(
  includedSlugs: string[],
  period: string,
  nowMs: number
): UsageReport {
  const includedWeight = includedSlugs.reduce(
    (s, x) => s + (WEIGHT_OF.get(x) ?? 0),
    0
  );
  const weightFrac = TOTAL_WEIGHT > 0 ? includedWeight / TOTAL_WEIGHT : 0;

  const days = periodDays(period);
  const chartDays = Math.min(days, 30);

  const dayCost = (k: number) => includedWeight * wave(nowMs, k);

  let totalCostRaw = 0;
  for (let k = 0; k < days; k++) totalCostRaw += dayCost(k);
  const totalCost = round2(totalCostRaw);

  const totalTokens = Math.round(totalCost * TOKENS_PER_DOLLAR);
  const totalTurns = Math.max(1, Math.round(totalCost * TURNS_PER_DOLLAR));
  const totalSessions = Math.max(1, Math.round(totalTurns / 14));

  // Daily series (oldest → newest), anchored to nowMs.
  const daily: DailyBucket[] = [];
  for (let k = chartDays - 1; k >= 0; k--) {
    const cost = round2(dayCost(k));
    daily.push({
      date: localDate(nowMs - k * DAY),
      cost,
      inputTokens: Math.round(cost * TOKENS_PER_DOLLAR * TOK.input),
      outputTokens: Math.round(cost * TOKENS_PER_DOLLAR * TOK.output),
      turns: Math.max(1, Math.round(cost * TURNS_PER_DOLLAR)),
    });
  }

  const tokens = splitTokens(totalTokens);
  const cacheHitDenom = tokens.cacheRead + tokens.input + tokens.cacheCreate;
  const cacheHitRate = cacheHitDenom > 0 ? tokens.cacheRead / cacheHitDenom : 0;

  const byModel: ModelCost[] = MODELS.map((m) => {
    const cost = round2(totalCost * m.frac);
    const t = splitTokens(Math.round(totalTokens * m.frac));
    const mc: ModelCost = {
      model: m.model,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreateTokens: t.cacheCreate,
      cost,
      turns: Math.round(totalTurns * m.frac),
    };
    if (m.scr !== undefined) {
      mc.selfCorrectionRate = m.scr;
      mc.sessionsAsPrimary = Math.max(1, Math.round(totalSessions * m.frac));
    }
    return mc;
  }).sort((a, b) => b.cost - a.cost);

  const byCategory: CategoryBreakdown[] = CATS.map((c) => ({
    category: c.category,
    turns: Math.max(1, Math.round(totalTurns * c.frac)),
    tokens: Math.round(totalTokens * c.frac),
    cost: round2(totalCost * c.frac),
    oneShotRate: c.osr,
  })).sort((a, b) => b.cost - a.cost);

  const byProject: ProjectBreakdown[] = includedSlugs
    .map((slug) => {
      const frac =
        includedWeight > 0 ? (WEIGHT_OF.get(slug) ?? 0) / includedWeight : 0;
      return {
        projectSlug: `dev-${slug}`,
        projectDirName: `C--dev-${slug}`,
        tokens: Math.round(totalTokens * frac),
        cost: round2(totalCost * frac),
        turns: Math.max(1, Math.round(totalTurns * frac)),
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const projectDetails: ProjectDetail[] = includedSlugs
    .map((slug) => {
      const frac =
        includedWeight > 0 ? (WEIGHT_OF.get(slug) ?? 0) / includedWeight : 0;
      const pCost = round2(totalCost * frac);
      const pTurns = Math.max(1, Math.round(totalTurns * frac));
      const mcpServers = PROJECT_MCP[slug] ?? [];
      const detail: ProjectDetail = {
        projectSlug: `dev-${slug}`,
        projectDirName: `C--dev-${slug}`,
        cost: pCost,
        turns: pTurns,
        categoryBreakdown: CATS.slice(0, 6).map((c) => ({
          category: c.category,
          cost: round2(pCost * c.frac),
          turns: Math.max(1, Math.round(pTurns * c.frac)),
        })),
        topTools: TOOLS.slice(0, 5).map(
          ([name, f]) => [name, Math.max(1, Math.round(pTurns * f))] as [string, number]
        ),
        mcpServers,
        mcpCalls: mcpServers.length > 0 ? Math.max(1, Math.round(pTurns * 0.15)) : 0,
      };
      return detail;
    })
    .sort((a, b) => b.cost - a.cost);

  const toolTotal = Math.round(totalTurns * 2.6);
  const topTools: [string, number][] = TOOLS.map(
    ([name, f]) => [name, Math.max(1, Math.round(toolTotal * f))] as [string, number]
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const tt = Math.max(1, Math.round(totalTurns * 0.1));
  const toolTransitions: ToolTransition[] = [
    { from: "Read", to: "Edit", count: Math.round(tt * 1.6) },
    { from: "Edit", to: "Bash", count: Math.round(tt * 1.2) },
    { from: "Bash", to: "Read", count: Math.round(tt * 0.9) },
    { from: "Grep", to: "Read", count: Math.round(tt * 0.8) },
    { from: "Edit", to: "Read", count: Math.round(tt * 0.7) },
    { from: "Bash", to: "Edit", count: Math.round(tt * 0.6) },
  ].filter((x) => x.count > 0);

  const toolSelfLoops: ToolSelfLoop[] = [
    { tool: "Edit", count: Math.round(tt * 0.9) },
    { tool: "Read", count: Math.round(tt * 0.7) },
    { tool: "Bash", count: Math.round(tt * 0.5) },
    { tool: "Grep", count: Math.round(tt * 0.3) },
  ].filter((x) => x.count > 0);

  const shTotal = Math.round(totalTurns * 0.9);
  const shellStats: ShellStats[] = SHELLS.map(([binary, f]) => ({
    binary,
    count: Math.max(1, Math.round(shTotal * f)),
  })).sort((a, b) => b.count - a.count);

  const mc = Math.max(1, Math.round(totalTurns * 0.2));
  const mkServer = (server: string, tools: Record<string, number>): McpServerStats => ({
    server,
    tools,
    totalCalls: Object.values(tools).reduce((s, n) => s + n, 0),
  });
  const mcpStats: McpServerStats[] = [
    mkServer("project-minder", {
      "get-usage": Math.round(mc * 0.4),
      "list-sessions": Math.round(mc * 0.3),
      "get-portfolio-stats": Math.round(mc * 0.2),
    }),
    mkServer("github", {
      list_pull_requests: Math.round(mc * 0.15),
      get_pull_request: Math.round(mc * 0.1),
    }),
    mkServer("context-mode", {
      ctx_search: Math.round(mc * 0.12),
      ctx_execute: Math.round(mc * 0.08),
    }),
  ]
    .filter((s) => s.totalCalls > 0)
    .sort((a, b) => b.totalCalls - a.totalCalls);

  // Activity aggregates: full-history in the real report (period-independent),
  // so scale only by the included project share, never by period.
  const activityTurns = Math.max(1, Math.round(4200 * weightFrac));
  const bucket = (turns: number): ActivityBucket => ({
    turns,
    cost: round2(turns * COST_PER_TURN),
  });
  const byHourOfDay: ActivityBucket[] = HOUR_W.map((w) =>
    bucket(Math.round(activityTurns * w))
  );
  const byDayOfWeek: ActivityBucket[] = DAY_W.map((w) =>
    bucket(Math.round(activityTurns * w))
  );
  const byHourDay: ActivityBucket[][] = DAY_W.map((dw) =>
    HOUR_W.map((hw) => bucket(Math.round(activityTurns * dw * hw)))
  );

  // Contribution calendar: fixed 12-week (84-day) window anchored to nowMs,
  // aligned so weekIndex maps to calendar columns.
  const firstDow = new Date(nowMs - 83 * DAY).getDay();
  const contributionCalendar: ContributionCell[] = [];
  for (let i = 0; i < 84; i++) {
    const ms = nowMs - (83 - i) * DAY;
    const dow = new Date(ms).getDay();
    const weekend = dow === 0 || dow === 6;
    const base = (Math.sin(i * 0.5) + 1.3) * 20;
    const turns = Math.max(0, Math.round(base * weightFrac * (weekend ? 0.4 : 1)));
    contributionCalendar.push({
      date: localDate(ms),
      turns,
      cost: round2(turns * COST_PER_TURN),
      weekIndex: Math.floor((i + firstDow) / 7),
      dayOfWeek: dow,
    });
  }

  const verified = Math.max(1, Math.round(totalTurns * 0.12));
  const oneShotTasks = Math.round(verified * 0.68);

  const bySource: SourceBreakdown[] = [
    {
      source: "claude",
      displayName: "Claude Code",
      cost: totalCost,
      tokens: totalTokens,
      sessionCount: totalSessions,
    },
  ];

  return {
    period,
    totalCost,
    totalTokens,
    totalSessions,
    totalTurns,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheCreate,
    },
    cacheHitRate,
    oneShot: {
      totalVerifiedTasks: verified,
      oneShotTasks,
      rate: verified > 0 ? oneShotTasks / verified : 0,
    },
    daily,
    byModel,
    byProject,
    byCategory,
    topTools,
    toolTransitions,
    toolSelfLoops,
    shellStats,
    mcpStats,
    projectDetails,
    generatedAt: new Date(nowMs).toISOString(),
    byHourOfDay,
    byDayOfWeek,
    byHourDay,
    streak: {
      currentDays: 6,
      longestDays: 19,
      lastActiveDate: localDate(nowMs),
      totalActiveDays: Math.max(1, Math.round(72 * weightFrac)),
    },
    contributionCalendar,
    bySource,
    subagentCost: round2(totalCost * 0.18),
    subagentTokens: Math.round(totalTokens * 0.15),
  };
}

/**
 * `getUsage` façade fixture. When `project` (a `dev-<slug>` usage slug) matches
 * a demo project the report is scoped to just that project's slice; otherwise
 * the whole portfolio.
 */
export function demoUsage(
  period: AggregatorPeriod,
  project: string | undefined,
  nowMs: number
): UsageResult {
  const bare = project ? project.replace(/^dev-/, "") : undefined;
  const included =
    bare && WEIGHT_OF.has(bare) ? [bare] : WEIGHTS.map((w) => w.slug);
  const report = buildReport(included, period, nowMs);
  return { report, meta: { backend: "file", maxMtimeMs: nowMs } };
}

/**
 * `getClaudeUsage` façade fixture. Scoped to the given filesystem project
 * paths (matched to demo weights by basename); not period-bounded, so it
 * reports an all-time-ish total.
 */
export function demoClaudeUsage(
  projectPaths: string[],
  nowMs: number
): ClaudeUsageResult {
  let weight = 0;
  for (const p of projectPaths) {
    const slug = (p.split(/[\\/]/).pop() ?? "").toLowerCase();
    weight += WEIGHT_OF.get(slug) ?? 0;
  }
  if (weight === 0) weight = TOTAL_WEIGHT;

  const cost = round2(weight * 85 * 0.9); // ≈ 85 days of history at ~0.9 avg
  const totalTokens = Math.round(cost * TOKENS_PER_DOLLAR);
  const t = splitTokens(totalTokens);
  const totalTurns = Math.max(1, Math.round(cost * TURNS_PER_DOLLAR));
  const tu = Math.round(totalTurns * 2.6);

  const stats: ClaudeUsageStats = {
    totalTokens,
    inputTokens: t.input,
    outputTokens: t.output,
    cacheCreateTokens: t.cacheCreate,
    cacheReadTokens: t.cacheRead,
    totalTurns,
    toolUsage: {
      Read: Math.round(tu * 0.22),
      Edit: Math.round(tu * 0.16),
      Bash: Math.round(tu * 0.14),
      Grep: Math.round(tu * 0.11),
      Glob: Math.round(tu * 0.07),
      Write: Math.round(tu * 0.06),
      TodoWrite: Math.round(tu * 0.05),
      Task: Math.round(tu * 0.04),
    },
    errorCount: Math.round(totalTurns * 0.02),
    modelsUsed: MODELS.map((m) => m.model),
    costEstimate: cost,
    conversationCount: Math.max(1, Math.round(totalTurns / 22)),
  };
  return { stats, meta: { backend: "file", maxMtimeMs: nowMs } };
}

/** Per-period scale factor for agent/skill invocation counts. */
function invScale(period: string): number {
  switch (period) {
    case "today":
    case "24h":
      return 1;
    case "7d":
    case "week":
      return 2;
    case "30d":
    case "month":
      return 6;
    case "90d":
      return 14;
    case "1y":
      return 40;
    case "all":
      return 60;
    default:
      return 6;
  }
}

/** `getAgentUsage` façade fixture. */
export function demoAgentUsage(period: Period, nowMs: number): AgentUsageResult {
  const s = invScale(period);
  const AGENTS: { name: string; projects: Record<string, number>; cpi: number }[] = [
    {
      name: "Explore",
      projects: {
        "dev-aurora-commerce": 8,
        "dev-pulse-analytics": 5,
        "dev-quill-cms": 4,
        "dev-ledger-api": 3,
      },
      cpi: 0.35,
    },
    {
      name: "general-purpose",
      projects: {
        "dev-aurora-commerce": 6,
        "dev-pulse-analytics": 4,
        "dev-atlas-cli": 3,
      },
      cpi: 0.5,
    },
    {
      name: "code-reviewer",
      projects: {
        "dev-aurora-commerce": 5,
        "dev-ledger-api": 3,
        "dev-pulse-analytics": 2,
      },
      cpi: 0.85,
    },
    {
      name: "Plan",
      projects: { "dev-aurora-commerce": 3, "dev-quill-cms": 2 },
      cpi: 0.7,
    },
    {
      name: "code-architect",
      projects: { "dev-aurora-commerce": 2, "dev-beacon-mobile": 1 },
      cpi: 0.9,
    },
    {
      name: "code-simplifier",
      projects: { "dev-pulse-analytics": 2, "dev-quill-cms": 1 },
      cpi: 0.6,
    },
  ];

  const stats: AgentStats[] = AGENTS.map((a) => {
    const projects: Record<string, number> = {};
    let invocations = 0;
    for (const [slug, base] of Object.entries(a.projects)) {
      const c = Math.max(1, Math.round(base * s));
      projects[slug] = c;
      invocations += c;
    }
    const st: AgentStats = {
      name: a.name,
      invocations,
      firstUsed: new Date(nowMs - 40 * DAY).toISOString(),
      lastUsed: new Date(nowMs - 6 * HOUR).toISOString(),
      projects,
      sessions: [`demo-sess-${a.name}-1`, `demo-sess-${a.name}-2`],
    };
    if (period === "all") {
      const costUsd = round2(invocations * a.cpi);
      st.costUsd = costUsd;
      st.inputTokens = Math.round(costUsd * 8000);
      st.outputTokens = Math.round(costUsd * 4000);
    }
    return st;
  }).sort((a, b) => b.invocations - a.invocations);

  return { stats, meta: { backend: "file" } };
}

/** `getSkillUsage` façade fixture. */
export function demoSkillUsage(period: Period, nowMs: number): SkillUsageResult {
  const s = invScale(period);
  const SKILLS: { name: string; projects: Record<string, number> }[] = [
    {
      name: "code-review",
      projects: { "dev-aurora-commerce": 6, "dev-ledger-api": 3, "dev-pulse-analytics": 2 },
    },
    {
      name: "deep-research",
      projects: { "dev-pulse-analytics": 4, "dev-aurora-commerce": 3 },
    },
    {
      name: "context-mode:context-mode",
      projects: { "dev-aurora-commerce": 4, "dev-atlas-cli": 2 },
    },
    {
      name: "verify",
      projects: { "dev-aurora-commerce": 3, "dev-quill-cms": 2 },
    },
    {
      name: "artifact-design",
      projects: { "dev-pulse-analytics": 3 },
    },
    {
      name: "dataviz",
      projects: { "dev-pulse-analytics": 2, "dev-quill-cms": 1 },
    },
  ];

  const stats: SkillStats[] = SKILLS.map((sk) => {
    const projects: Record<string, number> = {};
    let invocations = 0;
    for (const [slug, base] of Object.entries(sk.projects)) {
      const c = Math.max(1, Math.round(base * s));
      projects[slug] = c;
      invocations += c;
    }
    return {
      name: sk.name,
      invocations,
      firstUsed: new Date(nowMs - 55 * DAY).toISOString(),
      lastUsed: new Date(nowMs - 9 * HOUR).toISOString(),
      projects,
      sessions: [`demo-sess-${sk.name}-1`, `demo-sess-${sk.name}-2`],
    };
  }).sort((a, b) => b.invocations - a.invocations);

  return { stats, meta: { backend: "file" } };
}
