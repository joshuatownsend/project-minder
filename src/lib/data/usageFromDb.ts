import "server-only";
import type DatabaseT from "better-sqlite3";
import type {
  UsageReport,
  ModelCost,
  ProjectBreakdown,
  CategoryBreakdown,
  CategoryType,
  DailyBucket,
  ProjectDetail,
  McpServerStats,
  SourceBreakdown,
  PeriodSummary,
  MetricDelta,
  UsageComparison,
} from "@/lib/usage/types";
import { getAdapterDisplayNameMap } from "@/lib/adapters";
import { parseStoredArgs } from "@/lib/db/storedArgs";
import { periodSinceIso } from "@/lib/usage/period";
import { groupByBinary } from "@/lib/usage/shellParser";
import { prepCached } from "@/lib/db/connection";
import { bucketByHourDay, toLocalDateStr } from "@/lib/usage/activityBuckets";
import { computeStreaks } from "@/lib/usage/streaks";
import { computeContributionCalendar } from "@/lib/usage/contributionCalendar";

// SQL-aggregate read path for /api/usage. Builds a `UsageReport`
// directly from `SELECT SUM(...) GROUP BY ...` queries against the
// indexed schema — the structural perf win that the master plan
// budgeted at 8–15 s → 50–200 ms for /api/usage.
//
// Aggregates that are pure SQL (every dimension below) come from a
// single query each. Two dimensions still need a small JS-side pass:
//
// * `shellStats` — needs `extractBinary(command)` to tokenize `npm test`
//   into `npm`. We pull only `arguments_json` for Bash / PowerShell rows
//   in the period (a tiny subset) and run `groupByBinary` on the result.
// * `mcpStats` — the SQL groups by (server, tool); we re-shape into the
//   nested `McpServerStats[]` the UI consumes.
//
// Two known divergences from the file-parse aggregator, both intentional:
//
// 1. `byCategory.oneShotRate` is left undefined. Computing it would
//    require a per-(category, session) one-shot pre-aggregate — a much
//    wider schema bump than this slice. Consumers needing the rate fall
//    back to file-parse.
// 2. `oneShot` aggregates are session-level sums (`SUM(verified_task_count),
//    SUM(one_shot_task_count) FROM sessions WHERE end_ts >= @periodStart`).
//    For boundary sessions whose turns straddle `periodStart`, the
//    file-parse path computes one-shot only over filtered turns; the SQL
//    path includes the whole session. period=all has zero divergence;
//    bounded periods over-count boundary sessions slightly.

/** Convert a Period token to an inclusive ISO start timestamp, or null for "all".
 *  Re-export of `periodSinceIso` from `usage/period.ts` so existing call sites
 *  in this file keep their familiar name. The single source of the helper
 *  is `period.ts`; this name remains here for back-compat. */
export const periodStartIso = periodSinceIso;

/**
 * Max `file_mtime_ms` across all sessions. Analog of `getJsonlMaxMtime`
 * for the file-parse path — used as the ETag input so cached responses
 * invalidate when any session JSONL grows or rotates. The indexer's
 * `appendSessionTail` updates `file_mtime_ms` on every tail, so this
 * advances as soon as a file changes.
 */
export function getDbMaxMtimeMs(db: DatabaseT.Database): number {
  const row = prepCached(db, "SELECT MAX(file_mtime_ms) AS m FROM sessions")
    .get() as { m: number | null } | undefined;
  return row?.m ?? 0;
}

/**
 * True if migration v3 ran but no reconcile has populated `turns.cost_usd`
 * + `category_costs` yet. The SQL aggregate path returns zeros while this
 * flag is set; the façade falls back to file-parse so /api/usage stays
 * accurate during the v3 catch-up window.
 */
export function needsReconcileAfterV3(db: DatabaseT.Database): boolean {
  const row = prepCached(db, "SELECT value FROM meta WHERE key = 'needs_reconcile_after_v3'")
    .get() as { value?: string } | undefined;
  return row?.value === "1";
}

interface FilterParams {
  /** Inclusive ISO timestamp lower bound for `t.ts`. null for "all". */
  periodStart: string | null;
  /** Project slug filter. null for "all projects". */
  project: string | null;
  /** YYYY-MM-DD slice of `periodStart` for queries that filter by `day` column. */
  startDay: string | null;
  /** Adapter source filter (e.g. "claude"). null for all sources. */
  source: string | null;
  /**
   * Claude-home discriminator (#311): normalized home key to scope the
   * report to (`sessions.home_key`). null for all homes. Strict equality —
   * NULL home_key rows (adapter sessions) don't match any home filter.
   */
  home: string | null;
}

/**
 * Build a UsageReport entirely from SQL aggregates. Single read-side
 * entry point for the SQL backend.
 */
export function loadUsageReportFromSql(
  db: DatabaseT.Database,
  period: string,
  project?: string,
  source?: string,
  home?: string
): UsageReport {
  const periodStart = periodStartIso(period);
  const filter: FilterParams = {
    periodStart,
    project: project ?? null,
    startDay: periodStart?.slice(0, 10) ?? null,
    source: source ?? null,
    home: home ?? null,
  };

  const totals = queryTotals(db, filter);
  const bySource = queryBySource(db, filter);
  const byModel = queryByModel(db, filter);
  const byProject = queryByProject(db, filter);
  const byCategory = queryByCategory(db, filter);
  const daily = queryDaily(db, filter);
  const topTools = queryTopTools(db, filter);
  const mcpStats = queryMcpStats(db, filter);
  const shellStats = queryShellStats(db, filter);
  const oneShot = queryOneShot(db, filter);
  const projectDetails = queryProjectDetails(db, filter);
  const activityTurns = queryActivityTurns(db, filter);
  const { byHourOfDay, byDayOfWeek, byHourDay } = bucketByHourDay(activityTurns);
  const streak = computeStreaks(activityTurns);
  const contributionCalendar = computeContributionCalendar(activityTurns);

  const subagent = querySubagentTotals(db, filter);

  const totalTokens =
    totals.input_tokens + totals.output_tokens + totals.cache_create_tokens + totals.cache_read_tokens;
  // A7: include cache-write tokens in the denominator (matches aggregator.ts).
  const cacheHitDenominator =
    totals.cache_read_tokens + totals.input_tokens + totals.cache_create_tokens;
  const cacheHitRate = cacheHitDenominator > 0 ? totals.cache_read_tokens / cacheHitDenominator : 0;

  return {
    period,
    totalCost: totals.cost_usd,
    totalTokens,
    totalSessions: totals.distinct_sessions,
    totalTurns: totals.assistant_turns,
    tokens: {
      input: totals.input_tokens,
      output: totals.output_tokens,
      cacheRead: totals.cache_read_tokens,
      cacheWrite: totals.cache_create_tokens,
    },
    cacheHitRate,
    oneShot,
    daily,
    byModel,
    byProject,
    byCategory,
    topTools,
    toolTransitions: [],
    toolSelfLoops: [],
    shellStats,
    mcpStats,
    projectDetails,
    generatedAt: new Date().toISOString(),
    byHourOfDay,
    byDayOfWeek,
    byHourDay,
    streak,
    contributionCalendar,
    bySource,
    subagentCost: subagent.cost,
    subagentTokens: subagent.tokens,
  };
}

/**
 * A1: subagent (sidechain) spend broken out of the totals. Same period/project/
 * source filters as `queryTotals`, restricted to `is_sidechain = 1` rows. These
 * turns are already folded into the headline totals (their rows are counted by
 * `queryTotals`/`queryByModel`/etc. with no is_sidechain filter); this query
 * isolates just the subagent portion for the UI breakout.
 */
function querySubagentTotals(
  db: DatabaseT.Database,
  f: FilterParams
): { cost: number; tokens: number } {
  const row = prepCached(db,
      `SELECT
         COALESCE(SUM(t.cost_usd), 0) AS cost,
         COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_create_tokens), 0) AS tokens
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND t.is_sidechain = 1
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .get(f) as { cost: number; tokens: number };
  return { cost: row.cost, tokens: row.tokens };
}

// ── Query helpers ──────────────────────────────────────────────────────────

interface TotalsRow {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  assistant_turns: number;
  distinct_sessions: number;
}

function queryTotals(db: DatabaseT.Database, f: FilterParams): TotalsRow {
  // Two queries: one for assistant-turn aggregates (cost, tokens, turn
  // count), one for distinct-session count over ALL turns. The file-parse
  // aggregator counts unique session IDs across user+assistant turns
  // (every turn in the period is a "live session"); we mirror that.
  const a = prepCached(db,
      `SELECT
         COALESCE(SUM(t.cost_usd), 0)            AS cost_usd,
         COALESCE(SUM(t.input_tokens), 0)        AS input_tokens,
         COALESCE(SUM(t.output_tokens), 0)       AS output_tokens,
         COALESCE(SUM(t.cache_create_tokens), 0) AS cache_create_tokens,
         COALESCE(SUM(t.cache_read_tokens), 0)   AS cache_read_tokens,
         COUNT(*)                                AS assistant_turns
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .get(f) as Omit<TotalsRow, "distinct_sessions">;
  const sRow = prepCached(db,
      `SELECT COUNT(DISTINCT t.session_id) AS distinct_sessions
       FROM turns t JOIN sessions s USING (session_id)
       WHERE (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .get(f) as { distinct_sessions: number };
  return { ...a, distinct_sessions: sRow.distinct_sessions };
}

function queryBySource(db: DatabaseT.Database, f: FilterParams): SourceBreakdown[] {
  interface SourceRow { source: string; cost: number; tokens: number; sessionCount: number }
  const rows = prepCached(db,
      `SELECT
         s.source,
         COALESCE(SUM(t.cost_usd), 0) AS cost,
         COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_create_tokens), 0) AS tokens,
         COUNT(DISTINCT t.session_id) AS sessionCount
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY s.source
       ORDER BY cost DESC`
    )
    .all(f) as SourceRow[];

  const adapterDisplayNames = getAdapterDisplayNameMap();
  return rows.map((r) => ({
    source: r.source,
    displayName: adapterDisplayNames.get(r.source) ?? r.source,
    cost: r.cost,
    tokens: r.tokens,
    sessionCount: r.sessionCount,
  }));
}

function queryByModel(db: DatabaseT.Database, f: FilterParams): ModelCost[] {
  return prepCached(db,
      `SELECT
         t.model AS model,
         COALESCE(SUM(t.input_tokens), 0)        AS inputTokens,
         COALESCE(SUM(t.output_tokens), 0)       AS outputTokens,
         COALESCE(SUM(t.cache_read_tokens), 0)   AS cacheReadTokens,
         COALESCE(SUM(t.cache_create_tokens), 0) AS cacheCreateTokens,
         COALESCE(SUM(t.cost_usd), 0)            AS cost,
         COUNT(*)                                AS turns
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY t.model
       ORDER BY cost DESC`
    )
    .all(f) as ModelCost[];
}

function queryByProject(db: DatabaseT.Database, f: FilterParams): ProjectBreakdown[] {
  // Grouped per (slug, home) so two homes with identical path layouts (same
  // project_slug) keep separable rows — mirrors the file-parse aggregator's
  // composite projectMap key (#311). Single-home setups have one uniform
  // home_key, so their row count is unchanged.
  const rows = prepCached(db,
      `SELECT
         s.project_slug      AS projectSlug,
         s.project_dir_name  AS projectDirName,
         s.home_key          AS homeKey,
         COALESCE(SUM(t.input_tokens + t.output_tokens
                    + t.cache_create_tokens + t.cache_read_tokens), 0) AS tokens,
         COALESCE(SUM(t.cost_usd), 0) AS cost,
         COUNT(*)                     AS turns
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY s.project_slug, s.project_dir_name, s.home_key
       ORDER BY cost DESC`
    )
    .all(f) as Array<ProjectBreakdown & { homeKey: string | null }>;
  // NULL → omitted, matching the file backend (homeKey is absent on rows
  // whose turns carry no home stamp) so the two backends serialize alike.
  return rows.map(({ homeKey, ...rest }) =>
    homeKey === null ? rest : { ...rest, homeKey }
  );
}

function queryByCategory(db: DatabaseT.Database, f: FilterParams): CategoryBreakdown[] {
  // Source- or home-filtered: the `category_costs` rollup is keyed only by
  // (day, project, category) with no `source`/`home_key` column, so it can't
  // answer per-source or per-home. Recompute from `turns` joined to `sessions`
  // (same approach as `queryDaily` / `queryByModel`) — otherwise a `?source=`
  // or `?home=` byCategory would mix everything while every other breakdown
  // on the report is filtered. The token formula matches the rollup's
  // (`refreshCategoryCosts`): input + output + cache_create + cache_read.
  if (f.source !== null || f.home !== null) {
    const rows = prepCached(db,
        `SELECT
           t.category                 AS category,
           COUNT(*)                   AS turns,
           COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_create_tokens + t.cache_read_tokens), 0) AS tokens,
           COALESCE(SUM(t.cost_usd), 0) AS cost
         FROM turns t JOIN sessions s USING (session_id)
         WHERE t.role = 'assistant'
           AND t.category IS NOT NULL
           AND (@periodStart IS NULL OR t.ts >= @periodStart)
           AND (@project IS NULL OR s.project_slug = @project)
           AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
         GROUP BY t.category
         ORDER BY cost DESC`
      )
      .all(f) as Array<{ category: string; turns: number; tokens: number; cost: number }>;
    return rows.map((r) => ({
      category: r.category as CategoryType,
      turns: r.turns,
      tokens: r.tokens,
      cost: r.cost,
    }));
  }

  // Source-agnostic (the common case): read the fast `category_costs` rollup.
  // `oneShotRate` is intentionally omitted — see header comment.
  const rows = prepCached(db,
      `SELECT
         category,
         COALESCE(SUM(turns), 0)    AS turns,
         COALESCE(SUM(tokens), 0)   AS tokens,
         COALESCE(SUM(cost_usd), 0) AS cost
       FROM category_costs
       WHERE (@startDay IS NULL OR day >= @startDay)
         AND (@project IS NULL OR project_slug = @project)
       GROUP BY category
       ORDER BY cost DESC`
    )
    .all(f) as Array<{ category: string; turns: number; tokens: number; cost: number }>;
  return rows.map((r) => ({
    category: r.category as CategoryType,
    turns: r.turns,
    tokens: r.tokens,
    cost: r.cost,
  }));
}

function queryDaily(db: DatabaseT.Database, f: FilterParams): DailyBucket[] {
  // A2: bucket by LOCAL calendar date. We CANNOT `GROUP BY substr(t.ts,1,10)`
  // (UTC) and we don't group in SQL via `date(t.ts,'localtime')` either —
  // instead we fetch the period-filtered assistant rows and bucket in JS with
  // the SAME `toLocalDateStr` helper the file-parse aggregator uses. That
  // guarantees byte-identical dates across both backends (a SQLite localtime
  // conversion could drift from JS `Date` at tz-db edges). Sidechain rows are
  // intentionally NOT filtered — subagent spend belongs in the daily chart.
  const rows = prepCached(db,
      `SELECT t.ts AS ts, t.cost_usd AS cost, t.input_tokens AS inputTokens, t.output_tokens AS outputTokens
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .all(f) as Array<{ ts: string; cost: number; inputTokens: number; outputTokens: number }>;

  const byDay = new Map<string, DailyBucket>();
  for (const r of rows) {
    const date = toLocalDateStr(r.ts);
    const b = byDay.get(date) ?? { date, cost: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    b.cost += r.cost;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.turns++;
    byDay.set(date, b);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function queryTopTools(db: DatabaseT.Database, f: FilterParams): [string, number][] {
  const rows = prepCached(db,
      `SELECT tu.tool_name AS name, COUNT(*) AS count
       FROM tool_uses tu
       JOIN turns t USING (session_id, turn_index)
       JOIN sessions s ON s.session_id = t.session_id
       WHERE tu.tool_name NOT LIKE 'mcp__%'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY tu.tool_name
       ORDER BY count DESC
       LIMIT 15`
    )
    .all(f) as Array<{ name: string; count: number }>;
  return rows.map((r) => [r.name, r.count]);
}

function queryMcpStats(db: DatabaseT.Database, f: FilterParams): McpServerStats[] {
  const rows = prepCached(db,
      `SELECT tu.mcp_server AS server, tu.mcp_tool AS tool, COUNT(*) AS count
       FROM tool_uses tu
       JOIN turns t USING (session_id, turn_index)
       JOIN sessions s ON s.session_id = t.session_id
       WHERE tu.mcp_server IS NOT NULL
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY tu.mcp_server, tu.mcp_tool`
    )
    .all(f) as Array<{ server: string; tool: string; count: number }>;
  // `mcp_tool` is non-null whenever `mcp_server` is non-null — both come
  // from the same `parseMcpTool` call at ingest, which returns either
  // both fields or null. The WHERE clause already filters the null case.
  const serverMap = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const tools = serverMap.get(r.server) ?? {};
    tools[r.tool] = (tools[r.tool] ?? 0) + r.count;
    serverMap.set(r.server, tools);
  }
  return Array.from(serverMap.entries())
    .map(([server, tools]) => ({
      server,
      tools,
      totalCalls: Object.values(tools).reduce((s, n) => s + n, 0),
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

function queryActivityTurns(
  db: DatabaseT.Database,
  f: FilterParams
): Array<{ timestamp: string; cost?: number }> {
  // Full-history (no period filter) assistant turns for activity aggregates.
  // The project/source/home filters ARE applied so scoped activity is correct;
  // only the period bound is deliberately omitted (activity is full-history by
  // design). Scalability note: this is a full table scan on large DBs. The
  // /api/usage route has a 2-min globalThis cache (keyed by
  // backend:period:project:source:home) that absorbs repeated calls; the
  // cold-start cost is the only concern.
  const rows = prepCached(
    db,
    `SELECT t.ts AS timestamp, t.cost_usd AS cost
       FROM turns t JOIN sessions s USING (session_id)
      WHERE t.role = 'assistant'
        AND t.is_sidechain = 0
        AND (@project IS NULL OR s.project_slug = @project)
        AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
  ).all({ project: f.project, source: f.source, home: f.home }) as Array<{ timestamp: string; cost: number }>;
  return rows;
}

function queryShellStats(db: DatabaseT.Database, f: FilterParams) {
  // Pull only Bash / PowerShell rows in the filter window — typically a
  // small fraction of all tool calls — then tokenize commands in JS via
  // the same `groupByBinary` the file-parse path uses. parseStoredArgs
  // handles the rare truncated-JSON case.
  const rows = prepCached(db,
      `SELECT tu.arguments_json
       FROM tool_uses tu
       JOIN turns t USING (session_id, turn_index)
       JOIN sessions s ON s.session_id = t.session_id
       WHERE tu.tool_name IN ('Bash', 'PowerShell')
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .all(f) as Array<{ arguments_json: string | null }>;
  const commands: string[] = [];
  for (const r of rows) {
    const args = parseStoredArgs(r.arguments_json);
    if (args && typeof args.command === "string") commands.push(args.command);
  }
  return groupByBinary(commands);
}

function queryOneShot(db: DatabaseT.Database, f: FilterParams) {
  // Session-level sum. Boundary sessions over-count slightly for
  // bounded periods; period=all has zero divergence from file-parse.
  const row = prepCached(db,
      `SELECT
         COALESCE(SUM(verified_task_count), 0) AS verified,
         COALESCE(SUM(one_shot_task_count), 0) AS oneShot
       FROM sessions
       WHERE (@periodStart IS NULL OR end_ts >= @periodStart)
         AND (@project IS NULL OR project_slug = @project)
         AND (@source IS NULL OR source = @source)
         AND (@home IS NULL OR home_key = @home)`
    )
    .get(f) as { verified: number; oneShot: number };
  return {
    totalVerifiedTasks: row.verified,
    oneShotTasks: row.oneShot,
    rate: row.verified > 0 ? row.oneShot / row.verified : 0,
  };
}

function queryProjectDetails(db: DatabaseT.Database, f: FilterParams): ProjectDetail[] {
  // Three queries fan out per-project breakdowns: header, category mix,
  // top tools. We stitch in JS rather than SQL because building the
  // shape from a single query needs window functions / JSON aggregation
  // that would explode the SQL surface area for marginal gain.
  const headers = prepCached(db,
      `SELECT
         s.project_slug      AS projectSlug,
         s.project_dir_name  AS projectDirName,
         COALESCE(SUM(t.cost_usd), 0) AS cost,
         COUNT(*)                     AS turns
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND (@periodStart IS NULL OR t.ts >= @periodStart)
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)
       GROUP BY s.project_slug, s.project_dir_name
       ORDER BY cost DESC`
    )
    .all(f) as Array<{ projectSlug: string; projectDirName: string; cost: number; turns: number }>;
  if (headers.length === 0) return [];

  const slugs = headers.map((h) => h.projectSlug);
  const placeholders = slugs.map(() => "?").join(",");

  // The next three queries interpolate `IN (${placeholders})` whose
  // length tracks `headers.length`. That makes the SQL string
  // variable-shape — caching it would grow the prepared cache
  // unboundedly as project counts shift across requests, violating
  // `prepCached`'s static-SQL contract. Use `db.prepare()` directly
  // here. The three queries each fire once per request anyway, and
  // their wins come from the SQL aggregation, not the prepare.
  // The `category_costs` rollup has no home_key column, so a home-filtered
  // request recomputes the per-project category mix from `turns` (same
  // limitation-and-fallback as `queryByCategory`). The unfiltered path keeps
  // the fast rollup read.
  const catRows = (f.home !== null
    ? db
        .prepare(
          `SELECT s.project_slug AS projectSlug, t.category AS category,
                  SUM(t.cost_usd) AS cost, COUNT(*) AS turns
           FROM turns t JOIN sessions s USING (session_id)
           WHERE t.role = 'assistant'
             AND t.category IS NOT NULL
             AND (? IS NULL OR t.ts >= ?)
             AND s.home_key = ?
             AND s.project_slug IN (${placeholders})
           GROUP BY s.project_slug, t.category
           ORDER BY cost DESC`
        )
        .all(f.periodStart, f.periodStart, f.home, ...slugs)
    : db
        .prepare(
          `SELECT cc.project_slug AS projectSlug, cc.category AS category,
                  SUM(cc.cost_usd) AS cost, SUM(cc.turns) AS turns
           FROM category_costs cc
           WHERE (? IS NULL OR cc.day >= ?)
             AND cc.project_slug IN (${placeholders})
           GROUP BY cc.project_slug, cc.category
           ORDER BY cost DESC`
        )
        .all(f.startDay, f.startDay, ...slugs)) as Array<{
    projectSlug: string;
    category: string;
    cost: number;
    turns: number;
  }>;

  // ORDER BY (projectSlug, count DESC) — global `ORDER BY count DESC`
  // would interleave rows from different projects, so the contiguous-
  // rows loop below would cap at 5 too early for some slugs and miss
  // their actual top tools. Per-slug ordering keeps each project's rows
  // contiguous and pre-sorted, making `if (list.length < 5)` correct.
  const toolRows = db
    .prepare(
      `SELECT s.project_slug AS projectSlug, tu.tool_name AS name, COUNT(*) AS count
       FROM tool_uses tu
       JOIN turns t USING (session_id, turn_index)
       JOIN sessions s ON s.session_id = t.session_id
       WHERE tu.tool_name NOT LIKE 'mcp__%'
         AND (? IS NULL OR t.ts >= ?)
         AND (? IS NULL OR s.home_key = ?)
         AND s.project_slug IN (${placeholders})
       GROUP BY s.project_slug, tu.tool_name
       ORDER BY s.project_slug, count DESC`
    )
    .all(f.periodStart, f.periodStart, f.home, f.home, ...slugs) as Array<{
    projectSlug: string;
    name: string;
    count: number;
  }>;

  const mcpRows = db
    .prepare(
      `SELECT s.project_slug AS projectSlug, tu.mcp_server AS server, COUNT(*) AS count
       FROM tool_uses tu
       JOIN turns t USING (session_id, turn_index)
       JOIN sessions s ON s.session_id = t.session_id
       WHERE tu.mcp_server IS NOT NULL
         AND (? IS NULL OR t.ts >= ?)
         AND (? IS NULL OR s.home_key = ?)
         AND s.project_slug IN (${placeholders})
       GROUP BY s.project_slug, tu.mcp_server`
    )
    .all(f.periodStart, f.periodStart, f.home, f.home, ...slugs) as Array<{
    projectSlug: string;
    server: string;
    count: number;
  }>;

  const catBySlug = new Map<string, ProjectDetail["categoryBreakdown"]>();
  for (const r of catRows) {
    const list = catBySlug.get(r.projectSlug) ?? [];
    list.push({ category: r.category as CategoryType, cost: r.cost, turns: r.turns });
    catBySlug.set(r.projectSlug, list);
  }
  const toolsBySlug = new Map<string, [string, number][]>();
  for (const r of toolRows) {
    const list = toolsBySlug.get(r.projectSlug) ?? [];
    if (list.length < 5) list.push([r.name, r.count]);
    toolsBySlug.set(r.projectSlug, list);
  }
  const mcpBySlug = new Map<string, { servers: string[]; calls: number }>();
  for (const r of mcpRows) {
    const entry = mcpBySlug.get(r.projectSlug) ?? { servers: [], calls: 0 };
    entry.servers.push(r.server);
    entry.calls += r.count;
    mcpBySlug.set(r.projectSlug, entry);
  }

  return headers.map((h) => ({
    projectSlug: h.projectSlug,
    projectDirName: h.projectDirName,
    cost: h.cost,
    turns: h.turns,
    categoryBreakdown: catBySlug.get(h.projectSlug) ?? [],
    topTools: toolsBySlug.get(h.projectSlug) ?? [],
    mcpServers: mcpBySlug.get(h.projectSlug)?.servers ?? [],
    mcpCalls: mcpBySlug.get(h.projectSlug)?.calls ?? 0,
  }));
}

// ── Period-over-period comparison ───────────────────────────────────────────
// Item 4a: current window vs the immediately preceding window of equal
// *elapsed* length. The elapsed-duration framing (rather than nominal period
// length) is what makes "today" honest: at 9am it compares the last ~9h to
// the 9h before midnight, not a partial day against a full one. For rolling
// windows (24h/7d/30d) elapsed == nominal length so the math is unchanged.
//
// Pure SQL over already-indexed columns — no schema change. Uses a focused
// two-query summary per window (`queryPeriodSummary`), NOT `loadUsageReport-
// FromSql`: the full report has no upper-bound filter and computes full-
// history activity/streak/calendar aggregates that are meaningless in a
// bounded compare.

/** Inclusive-start, exclusive-end window plus the project/source/home filter. */
interface WindowParams {
  start: string;
  end: string;
  project: string | null;
  source: string | null;
  home: string | null;
}

interface SummaryAggRow {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  assistant_turns: number;
}

/**
 * Scalar usage summary for one bounded [start, end) window. Three small
 * aggregate queries (turn rollup, distinct sessions, one-shot rollup) — the
 * same shape `queryTotals` + `queryOneShot` produce for the full report, but
 * with an upper bound so a *previous* window can be isolated.
 */
function queryPeriodSummary(db: DatabaseT.Database, w: WindowParams): PeriodSummary {
  const a = prepCached(db,
      `SELECT
         COALESCE(SUM(t.cost_usd), 0)            AS cost_usd,
         COALESCE(SUM(t.input_tokens), 0)        AS input_tokens,
         COALESCE(SUM(t.output_tokens), 0)       AS output_tokens,
         COALESCE(SUM(t.cache_create_tokens), 0) AS cache_create_tokens,
         COALESCE(SUM(t.cache_read_tokens), 0)   AS cache_read_tokens,
         COUNT(*)                                AS assistant_turns
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.role = 'assistant'
         AND t.ts >= @start AND t.ts < @end
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .get(w) as SummaryAggRow;
  const sRow = prepCached(db,
      `SELECT COUNT(DISTINCT t.session_id) AS sessions
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.ts >= @start AND t.ts < @end
         AND (@project IS NULL OR s.project_slug = @project)
         AND (@source IS NULL OR s.source = @source)
         AND (@home IS NULL OR s.home_key = @home)`
    )
    .get(w) as { sessions: number };
  const osRow = prepCached(db,
      `SELECT
         COALESCE(SUM(verified_task_count), 0) AS verified,
         COALESCE(SUM(one_shot_task_count), 0) AS oneShot
       FROM sessions
       WHERE end_ts >= @start AND end_ts < @end
         AND (@project IS NULL OR project_slug = @project)
         AND (@source IS NULL OR source = @source)
         AND (@home IS NULL OR home_key = @home)`
    )
    .get(w) as { verified: number; oneShot: number };

  const tokens =
    a.input_tokens + a.output_tokens + a.cache_create_tokens + a.cache_read_tokens;
  // A7: include cache-write tokens in the denominator (matches aggregator.ts).
  const cacheHitDenominator = a.cache_read_tokens + a.input_tokens + a.cache_create_tokens;
  return {
    cost: a.cost_usd,
    tokens,
    inputTokens: a.input_tokens,
    outputTokens: a.output_tokens,
    cacheReadTokens: a.cache_read_tokens,
    cacheCreateTokens: a.cache_create_tokens,
    sessions: sRow.sessions,
    turns: a.assistant_turns,
    cacheHitRate: cacheHitDenominator > 0 ? a.cache_read_tokens / cacheHitDenominator : 0,
    verifiedTasks: osRow.verified,
    oneShotTasks: osRow.oneShot,
    oneShotRate: osRow.verified > 0 ? osRow.oneShot / osRow.verified : 0,
  };
}

/** current − previous, with `pct` left null when previous is 0 (a ratio
 *  would be +∞ — the UI renders this as a "new" badge instead of a number). */
function metricDelta(current: number, previous: number, basis = true): MetricDelta {
  return {
    current,
    previous,
    absolute: current - previous,
    pct: previous !== 0 ? (current - previous) / previous : null,
    basis,
  };
}

/** A not-comparable result carrying only the period + reason. Shared by the
 *  "all" case here and the no-DB / v3-catch-up cases in the data façade so
 *  every caller emits the same shape. */
export function buildNotComparable(period: string, reason: string): UsageComparison {
  return { comparable: false, period, reason };
}

/**
 * Build a period-over-period `UsageComparison` from SQL aggregates. `now` is
 * injectable so both window bounds derive from a single instant (tests pin it;
 * production omits it). Returns a not-comparable result for "all" — there is
 * no window before all-time.
 */
export function compareUsageFromSql(
  db: DatabaseT.Database,
  period: string,
  project?: string,
  source?: string,
  home?: string,
  now: Date = new Date()
): UsageComparison {
  const periodStart = periodStartIso(period, now);
  if (periodStart === null) {
    return buildNotComparable(period, "Select a bounded period (24h, 7d, or 30d) to compare against the one before it.");
  }

  const nowMs = now.getTime();
  const elapsedMs = nowMs - new Date(periodStart).getTime();
  const currentWindow = { start: periodStart, end: now.toISOString() };
  const previousWindow = {
    start: new Date(nowMs - 2 * elapsedMs).toISOString(),
    end: periodStart,
  };

  const filter = { project: project ?? null, source: source ?? null, home: home ?? null };
  const current = queryPeriodSummary(db, { ...currentWindow, ...filter });
  const previous = queryPeriodSummary(db, { ...previousWindow, ...filter });

  // Rate metrics only have a basis when BOTH windows actually measured the
  // rate — otherwise the 0-fallback for an empty window reads as a real
  // regression/improvement. Cache-hit's denominator is (input + cacheRead)
  // tokens; one-shot's is verified tasks. Volume metrics need no guard.
  const cacheBasis =
    current.inputTokens + current.cacheReadTokens + current.cacheCreateTokens > 0 &&
    previous.inputTokens + previous.cacheReadTokens + previous.cacheCreateTokens > 0;
  const oneShotBasis = current.verifiedTasks > 0 && previous.verifiedTasks > 0;

  return {
    comparable: true,
    period,
    current,
    previous,
    currentWindow,
    previousWindow,
    deltas: {
      cost: metricDelta(current.cost, previous.cost),
      tokens: metricDelta(current.tokens, previous.tokens),
      sessions: metricDelta(current.sessions, previous.sessions),
      cacheHitRate: metricDelta(current.cacheHitRate, previous.cacheHitRate, cacheBasis),
      oneShotRate: metricDelta(current.oneShotRate, previous.oneShotRate, oneShotBasis),
    },
  };
}
