import { parseAllSessions } from "./parser";
import { classifyTurn } from "./classifier";
import { computeToolTransitions } from "./toolTransitions";
import { computeTurnCost, loadPricing } from "./costCalculator";
import { groupByBinary, extractBashCommands } from "./shellParser";
import { groupMcpCalls } from "./mcpParser";
import { detectOneShotTasks } from "./oneShotDetector";
import { effortBucket, compareEffort } from "./effort";
import { entrypointBucket, compareEntrypoint, isBackgroundSession } from "./entrypoint";
import { mcpServerKey, isAttributed } from "./attribution";
import { parseMcpTool } from "./mcpParser";
import { SKILL_DISPATCH_TOOL } from "./toolNames";
import { getPeriodStart } from "./periods";
import { detectSelfCorrectionPerModel } from "./selfCorrection";
import { bucketByHourDay, toLocalDateStr, type ActivityData } from "./activityBuckets";
import { computeStreaks } from "./streaks";
import { computeContributionCalendar } from "./contributionCalendar";
import { computeProjectYield } from "./computeProjectYield";
import { gatherProjectTurns, projectDirNameCandidates } from "./projectMatch";
import { readConfig } from "../config";
import { getClaudeHomes } from "../claudeHome";
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
  EffortBreakdown,
  DailyBucket,
  ToolCall,
  PortfolioYield,
  SourceBreakdown,
} from "./types";

import type { AggregatorPeriod as Period } from "./period";

// `Period` here is the alias `AggregatorPeriod` from `period.ts` —
// canonical 5-option vocabulary plus the legacy `week`/`month` aliases
// that `getPeriodStart` still normalizes. The aliasing makes
// `generateUsageReport(period: Period, …)` read as before while
// pointing at a single named type shared with `runFileUsage` and
// `getUsage` in `data/index.ts`.

export async function generateUsageReport(
  period: Period,
  project?: string,
  source?: string,
  home?: string
): Promise<UsageReport> {
  // includeSidechains: fold subagent (Task) turns into the usage aggregates.
  // Their tokens/cost belong in the totals (A1); session-scoped detectors and
  // activity aggregates still filter them out below.
  const sessionMap = await parseAllSessions({ includeSidechains: true });

  let turns: UsageTurn[] = [];
  for (const sessionTurns of sessionMap.values()) {
    turns.push(...sessionTurns);
  }

  // Project + source filters first (before period) — activity aggregates are
  // project/source-scoped but use full history (not period-filtered).
  if (project) {
    turns = turns.filter((t) => t.projectSlug === project);
  }
  if (source) {
    turns = turns.filter((t) => (t.source ?? "claude") === source);
  }
  // Home discriminator (#311): scope the report to turns recorded by ONE
  // configured Claude home. Strict equality — a turn with no home stamp
  // (adapter sources, single-session loads) is excluded rather than
  // guessed, matching the DB backend's `home_key = @home` semantics.
  if (home) {
    turns = turns.filter((t) => t.homeKey === home);
  }

  // Activity/streak/heatmap reflect when the developer was working — subagent
  // turns run inside a parent turn and aren't independent activity, so keep
  // these on primary turns only (they also drove the historical numbers).
  const assistantTurnsFullHistory = turns.filter(
    (t) => t.role === "assistant" && !t.isSidechain
  );
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
    await augmentPortfolioYield(report, { source, home });
  }

  return report;
}

/**
 * Restrict a session map to the report's scope, or return it unchanged when no
 * scope applies.
 *
 * **Takes every filter axis, not one.** The first version of this took `source`
 * alone and `home` was found missing one review round later — which is the
 * predictable shape of the underlying problem: `augmentPortfolioYield` re-reads
 * the full session map instead of reusing the report's already-filtered turns,
 * so each axis has to be re-threaded by hand and each is a separate chance to
 * forget one. A single scope object means the next axis added to
 * `generateUsageReport` fails to compile here rather than silently leaking.
 * (Codex P2 ×2, PR #490.)
 *
 * Both discriminators match the report-level filters exactly so the two cannot
 * disagree: `t.source ?? "claude"` treats an unstamped turn as Claude, and
 * `home` is STRICT equality on `homeKey`, which excludes adapter turns entirely
 * because they carry no home stamp — "excluded rather than guessed", matching
 * the DB backend's `home_key = @home`. Keyed on the head turn because a session
 * mixes neither source nor home.
 *
 * Exported so its test exercises this function rather than a copy of the
 * expression: a test that re-implements the filter it is checking passes
 * whatever the production code does, which is a failure this PR's own review has
 * already turned up twice.
 */
export interface SessionMapScope {
  source?: string;
  home?: string;
}

export function scopeSessionMap(
  sessionMap: Map<string, UsageTurn[]>,
  scope: SessionMapScope = {}
): Map<string, UsageTurn[]> {
  const { source, home } = scope;
  if (!source && !home) return sessionMap;
  return new Map(
    [...sessionMap].filter(([, turns]) => {
      if (turns.length === 0) return false;
      const head = turns[0];
      if (source && (head.source ?? "claude") !== source) return false;
      if (home && head.homeKey !== home) return false;
      return true;
    })
  );
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
export async function augmentPortfolioYield(
  report: UsageReport,
  /**
   * The scope the report was built under. Must be threaded through: this
   * function re-reads the FULL session map rather than reusing the report's
   * already-filtered turns, and `gatherProjectTurns` matches on project identity
   * alone. Before file-parse had adapter discovery that was harmless — the map
   * only ever held Claude sessions — but now a `source=claude` or `home=`-scoped
   * report would classify Codex and Gemini sessions into its yield while every
   * other figure in the response excluded them. (Codex P2 ×2, PR #490.)
   */
  scope: SessionMapScope = {}
): Promise<void> {
  const scan = getCachedScan();
  if (!scan || report.projectDetails.length === 0) return;

  const sessionMap = scopeSessionMap(await parseAllSessions(), scope);
  // Key by encoded path (e.g. "C--dev-project-minder") so it matches
  // pd.projectDirName from the usage parser, not the scanner's short slug.
  // A UNC-scanned WSL project's turns carry the FOREIGN encoding (the Linux
  // path they were recorded under), so key every candidate encoding.
  const cfg = await readConfig();
  const pathMappings = cfg.pathMappings ?? [];
  const claudeHomes = getClaudeHomes(cfg);
  const projectPathMap = new Map(
    scan.projects.flatMap((p) =>
      projectDirNameCandidates(p.path, pathMappings, claudeHomes).map(
        (c) => [c.dirName, p.path] as const
      )
    )
  );

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
        const projectTurns = gatherProjectTurns(sessionMap, pd.projectSlug, path, pathMappings, claudeHomes);
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
/**
 * The same aggregation, fed in batches instead of all at once (#515).
 *
 * `aggregateUsage` is this with a single `addTurns` call, so the SQL backend's
 * behaviour is unchanged by construction rather than by inspection. The file
 * backend feeds one session per call and lets each session's turns go, which is
 * what removes the corpus from the sweep's peak.
 *
 * ## Batches must be session-complete
 *
 * Every session-scoped detector here — one-shot tasks, self-correction, tool
 * transitions — needs a session's turns together. It does NOT need them in the
 * same batch as any other session's. A caller that split one session across two
 * `addTurns` calls would see its tasks silently under-counted, so the sweep's
 * per-session granularity is a requirement, not a convenience.
 *
 * Order within a batch is preserved, and batches accumulate in call order, so
 * feeding sessions in map order produces the same map-insertion order — and
 * therefore the same tie-breaking in the cost-descending sorts below — as one
 * flat array did.
 */
export function createUsageAccumulator(period: Period) {
  // Single-pass aggregation across all dimensions
  const modelMap = new Map<string, ModelCost>();
  const projectMap = new Map<string, ProjectBreakdown>();
  const categoryMap = new Map<CategoryType, CategoryBreakdown>();
  /** Task outcomes per category, keyed by the ANCHOR turn's category (A5). */
  const categoryTasks = new Map<CategoryType, { verified: number; oneShot: number }>();
  const effortMap = new Map<string, EffortBreakdown>();
  /**
   * A3 entrypoint accumulator. Sets rather than counters because `sessions`
   * is a DISTINCT count — a bucket's turns span many sessions, and summing
   * turn counts would report a number several orders of magnitude too large
   * under a session-shaped label.
   */
  const entrypointAccum = new Map<
    string,
    { turns: number; tokens: number; cost: number; sessions: Set<string>; bgSessions: Set<string> }
  >();
  /**
   * A4 attribution accumulators. Explicit and inferred are collected in
   * PARALLEL rather than one falling through to the other per row, because the
   * emit step below picks one whole list: mixing them in a single chart would
   * blend figures that differ by ~11x (MCP) and ~373x (skills).
   */
  type CostAccum = { turns: number; tokens: number; cost: number };
  const mkAccum = (): CostAccum => ({ turns: 0, tokens: 0, cost: 0 });
  const skillExplicit = new Map<string, CostAccum>();
  const skillInferred = new Map<string, CostAccum>();
  const mcpExplicit = new Map<string, CostAccum & { display: string }>();
  // Per-tool split within each server, explicit path only — there is no
  // inferred counterpart worth trusting at this granularity.
  const mcpTools = new Map<string, Map<string, { turns: number; cost: number }>>();
  const mcpInferred = new Map<string, CostAccum & { display: string }>();
  // Task outcomes crossed with the skill that caused the work (A2's
  // `task_outcome` reused as the general join key it was built to be).
  const skillTasks = new Map<string, { verified: number; oneShot: number }>();
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
  // A1: subagent (sidechain) spend broken out of — but still folded into — the
  // totals below.
  let subagentCost = 0;
  let subagentTokens = 0;

  /**
   * Self-correction, accumulated as raw counts rather than as the rates the
   * detector reports. Rates cannot be merged across batches — averaging them
   * would weight a one-session batch equally with a thousand-session one — but
   * `corrected`/`total` add exactly, and the detector already exposes both.
   */
  const selfCorrAccum = new Map<string, { corrected: number; total: number }>();
  /**
   * The slim projection tool-transition analysis needs: session, timestamp, and
   * the tool names. Retained for the whole run because the analysis sorts
   * globally before walking, so it cannot be folded per batch without
   * reimplementing it — but this holds a few fields per turn instead of the
   * turn, and the `toolCalls` arrays are the same objects `allToolCalls`
   * already keeps.
   */
  const transitionInputs: { sessionId: string; timestamp: string; toolCalls: ToolCall[] }[] = [];
  /** DISTINCT sessions seen, for `totalSessions`. Ids only. */
  const sessionIds = new Set<string>();
  let assistantTurnCount = 0;
  // Run-level, because tasks are counted per batch and summed across them.
  let totalVerified = 0;
  let totalOneShot = 0;

  async function addTurns(turns: UsageTurn[]): Promise<void> {
    // `loadPricing` is idempotent — first cold call fetches LiteLLM pricing
    // and seeds a 24-h FileCache; subsequent calls return immediately.
    await loadPricing();

    for (const t of turns) sessionIds.add(t.sessionId);

    // Classify and cost only assistant turns (user turns have empty model/zero tokens)
    const assistantTurns = turns.filter((t) => t.role === "assistant");
    assistantTurnCount += assistantTurns.length;
    const enriched: { turn: UsageTurn; category: CategoryType; cost: number }[] = [];
    for (const turn of assistantTurns) {
      enriched.push({
        turn,
        category: classifyTurn(turn),
        cost: await computeTurnCost(turn),
      });
    }

    /**
     * Each assistant turn's category, by object identity, so the one-shot walk
     * below can ask "what was the anchor turn classified as?" without
     * re-classifying. `classifyTurn` is deterministic, but calling it twice
     * would make it possible for the spend side and the task side to be
     * computed under two different classifier versions after a future refactor.
     *
     * Per BATCH, not per run: it is only ever consulted for anchor turns in the
     * same batch, and keeping it for the run would retain every assistant turn
     * by key — the exact leak #515 exists to remove.
     */
    const categoryOfTurn = new Map<UsageTurn, CategoryType>();

  for (const { turn, category, cost } of enriched) {
    const tokens = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheCreateTokens;
    const isSub = turn.isSidechain === true;
    if (isSub) {
      subagentCost += cost;
      subagentTokens += tokens;
    }

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

    // Project — grouped per (slug, home) so two homes with identical path
    // layouts (same encoded dirname → same slug) keep separable rows; the
    // /costs join disambiguates on `homeKey` (#311). Single-home setups
    // stamp one uniform homeKey, so their row count is unchanged.
    const projKey = `${turn.projectSlug}\u0000${turn.homeKey ?? ""}`;
    const proj = projectMap.get(projKey) ?? {
      projectSlug: turn.projectSlug, projectDirName: turn.projectDirName,
      ...(turn.homeKey !== undefined ? { homeKey: turn.homeKey } : {}),
      tokens: 0, cost: 0, turns: 0,
    };
    proj.tokens += tokens;
    proj.cost += cost;
    proj.turns++;
    projectMap.set(projKey, proj);

    // Category
    const cat = categoryMap.get(category) ?? { category, turns: 0, tokens: 0, cost: 0 };
    cat.turns++;
    cat.tokens += tokens;
    cat.cost += cost;
    categoryMap.set(category, cat);
    categoryOfTurn.set(turn, category);

    // Effort (A2) — spend side. Subagent turns are included, matching
    // byModel/byProject/byCategory; the task side below is primary-only.
    {
      const key = effortBucket(turn.effort);
      const eff = effortMap.get(key) ?? {
        effort: key, turns: 0, tokens: 0, cost: 0,
        verifiedTasks: 0, oneShotTasks: 0,
      };
      eff.turns++;
      eff.tokens += tokens;
      eff.cost += cost;
      effortMap.set(key, eff);
    }

    // Entrypoint (A3). Session-scoped, but accumulated in this same
    // assistant-turn loop so the cost sums match `byEffort`/`byModel` exactly
    // and the DB backend's `t.role = 'assistant'` filter has a mirror.
    {
      const key = entrypointBucket(turn.entrypoint);
      const ep = entrypointAccum.get(key) ?? {
        turns: 0, tokens: 0, cost: 0,
        sessions: new Set<string>(), bgSessions: new Set<string>(),
      };
      ep.turns++;
      ep.tokens += tokens;
      ep.cost += cost;
      ep.sessions.add(turn.sessionId);
      if (isBackgroundSession(turn.sessionKind)) ep.bgSessions.add(turn.sessionId);
      entrypointAccum.set(key, ep);
    }

    // Attribution (A4) — spend side.
    {
      if (isAttributed(turn.attributionSkill)) {
        const a = skillExplicit.get(turn.attributionSkill) ?? mkAccum();
        a.turns++; a.tokens += tokens; a.cost += cost;
        skillExplicit.set(turn.attributionSkill, a);
      }
      if (isAttributed(turn.attributionMcpServer)) {
        const k = mcpServerKey(turn.attributionMcpServer);
        const a = mcpExplicit.get(k) ?? { ...mkAccum(), display: turn.attributionMcpServer };
        a.turns++; a.tokens += tokens; a.cost += cost;
        mcpExplicit.set(k, a);
        if (isAttributed(turn.attributionMcpTool)) {
          const tools = mcpTools.get(k) ?? new Map<string, { turns: number; cost: number }>();
          const t = tools.get(turn.attributionMcpTool) ?? { turns: 0, cost: 0 };
          t.turns++; t.cost += cost;
          tools.set(turn.attributionMcpTool, t);
          mcpTools.set(k, tools);
        }
      }
      // Inferred fallback, from the tool calls this turn ISSUED. Counted once
      // per (turn, target) so a turn calling the same server twice doesn't
      // double its cost.
      //
      // Primary turns only, unlike the explicit half above. The split follows
      // from where each signal lives: attribution is TURN-derived and the DB
      // stores sidechain turns with their attribution intact, so a delegating
      // skill rightly keeps its delegate's spend. Inference is TOOL-derived,
      // and ingest deliberately writes no `tool_uses` for sidechain turns —
      // so counting them here would make inferred spend depend on which
      // backend answered. It's the same rule the tool/shell/mcp stats below
      // already follow.
      if (!isSub) {
        const seenServers = new Set<string>();
        const seenSkills = new Set<string>();
        for (const tc of turn.toolCalls) {
          const mcp = parseMcpTool(tc.name);
          if (mcp && !seenServers.has(mcp.server)) {
            seenServers.add(mcp.server);
            const a = mcpInferred.get(mcp.server) ?? { ...mkAccum(), display: mcp.server };
            a.turns++; a.tokens += tokens; a.cost += cost;
            mcpInferred.set(mcp.server, a);
          }
          if (tc.name === SKILL_DISPATCH_TOOL) {
            const skill = typeof tc.arguments?.skill === "string" ? tc.arguments.skill : null;
            if (skill && !seenSkills.has(skill)) {
              seenSkills.add(skill);
              const a = skillInferred.get(skill) ?? mkAccum();
              a.turns++; a.tokens += tokens; a.cost += cost;
              skillInferred.set(skill, a);
            }
          }
        }
      }
    }

    // Daily — bucket by LOCAL date so the daily bars, the "today" period
    // filter (periods.ts, local midnight) and the contribution calendar
    // (also local) all agree (A2).
    const dateStr = toLocalDateStr(turn.timestamp);
    const day = dailyMap.get(dateStr) ?? { date: dateStr, cost: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    day.cost += cost;
    day.inputTokens += turn.inputTokens;
    day.outputTokens += turn.outputTokens;
    day.turns++;
    dailyMap.set(dateStr, day);

    // Tools — subagent turns don't contribute tool/shell/mcp stats (mirrors the
    // DB path, which never persists tool_uses for sidechain turns).
    if (!isSub) {
      for (const tc of turn.toolCalls) {
        allToolCalls.push(tc);
      }
      bashCommands.push(...extractBashCommands(turn));
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
    if (!isSub) {
      for (const tc of turn.toolCalls) {
        if (tc.name.startsWith("mcp__")) {
          const server = tc.name.split("__")[1] ?? tc.name;
          detail.mcpMap.set(server, (detail.mcpMap.get(server) ?? 0) + 1);
        } else {
          detail.toolMap.set(tc.name, (detail.toolMap.get(tc.name) ?? 0) + 1);
        }
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


  // Primary (non-subagent) turns for session-scoped detectors. Subagent turns
  // aren't user-verified tasks and their tool flow isn't the developer's, so
  // one-shot and self-correction detection exclude them (A1).
  const primaryTurns = turns.filter((t) => !t.isSidechain);

  // One-shot aggregate (needs both user+assistant turns for tool result detection)
  const sessionGroups = new Map<string, UsageTurn[]>();
  for (const t of primaryTurns) {
    const arr = sessionGroups.get(t.sessionId) ?? [];
    arr.push(t);
    sessionGroups.set(t.sessionId, arr);
  }
  for (const sessionTurns of sessionGroups.values()) {
    // One walk feeds both the headline rate and the effort cross-tab (A2).
    // Running the detector twice would let the two diverge the moment
    // anything about task identification changes.
    const tasks = detectOneShotTasks(sessionTurns);
    totalVerified += tasks.length;
    for (const task of tasks) {
      if (task.oneShot) totalOneShot++;
      // Attribute to the EDIT turn's effort, not the verification turn's —
      // the outcome judges the edit. See `OneShotTask`.
      const key = effortBucket(sessionTurns[task.anchorIndex]?.effort);
      const eff = effortMap.get(key);
      // Only counts an effort bucket the spend loop already created. An
      // anchor turn is an assistant turn in this same filtered set, so a
      // miss would mean the two loops disagree about which turns exist.
      if (eff) {
        eff.verifiedTasks++;
        if (task.oneShot) eff.oneShotTasks++;
      }
      // Same anchor turn, crossed with its category (A5).
      //
      // Until 2026-08-10 this was computed the other way round — each
      // category's turns were sliced out and `detectOneShot` re-run over the
      // slice. That could not work: the classifier puts the edit in `Coding`
      // and the `pnpm test` that judges it in `Testing`, so every ordinary
      // task was split across two slices, leaving an edit with no
      // verification in one and a verification with no edit in the other.
      // Neither half formed a task, and the field came back undefined on
      // essentially every category while the headline reported the task
      // normally. Anchoring matches `byEffort`, `bySkill`, and the
      // `turns.task_outcome` column the SQL backend reads.
      const anchorCategory = categoryOfTurn.get(sessionTurns[task.anchorIndex]);
      if (anchorCategory !== undefined) {
        const ct = categoryTasks.get(anchorCategory) ?? { verified: 0, oneShot: 0 };
        ct.verified++;
        if (task.oneShot) ct.oneShot++;
        categoryTasks.set(anchorCategory, ct);
      }

      // Same anchor turn, crossed with attribution (A4). Answers "which
      // skills produce work that passes verification first time?" — the
      // question `task_outcome` was made a turn-level column to allow.
      const anchorSkill = sessionTurns[task.anchorIndex]?.attributionSkill;
      if (isAttributed(anchorSkill)) {
        const st = skillTasks.get(anchorSkill) ?? { verified: 0, oneShot: 0 };
        st.verified++;
        if (task.oneShot) st.oneShot++;
        skillTasks.set(anchorSkill, st);
      }
    }
  }
    // Self-correction: run per batch and merge the counts. The detector groups
    // by session internally, so a session-complete batch yields exactly the
    // rows a whole-corpus call would have contributed for those sessions.
    for (const m of detectSelfCorrectionPerModel(primaryTurns).byModel) {
      const acc = selfCorrAccum.get(m.model) ?? { corrected: 0, total: 0 };
      acc.corrected += m.corrected;
      acc.total += m.total;
      selfCorrAccum.set(m.model, acc);
    }

    for (const t of assistantTurns) {
      if (t.isSidechain) continue;
      transitionInputs.push({
        sessionId: t.sessionId,
        timestamp: t.timestamp,
        toolCalls: t.toolCalls,
      });
    }
  }

  async function finalize(activity: ActivityData): Promise<UsageReport> {
  // Top tools (non-MCP). Derived from the run's accumulated tool calls, so it
  // belongs here rather than in a batch — recomputing it per batch would have
  // thrown away every earlier batch's counts.
  const toolCounts = new Map<string, number>();
  for (const tc of allToolCalls) {
    if (!tc.name.startsWith("mcp__")) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
    }
  }

  for (const eff of effortMap.values()) {
    if (eff.verifiedTasks > 0) eff.oneShotRate = eff.oneShotTasks / eff.verifiedTasks;
  }
  for (const [cat, t] of categoryTasks.entries()) {
    const breakdown = categoryMap.get(cat);
    // Left undefined, never 0, when a category anchored no task — "nothing
    // measured" has to stay distinguishable from "failed every time".
    if (breakdown && t.verified > 0) breakdown.oneShotRate = t.oneShot / t.verified;
  }

  // A7: cache-hit-rate denominator includes cache WRITE tokens so the rate
  // isn't overstated on cache-write-heavy sessions.
  const cacheHitDenominator = totalCacheRead + totalInput + totalCacheWrite;
  const cacheHitRate = cacheHitDenominator > 0 ? totalCacheRead / cacheHitDenominator : 0;
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const totalCost = [...modelMap.values()].reduce((s, m) => s + m.cost, 0);

  // Self-correction rate per primary model. The detector groups by
  // sessionId internally and attaches to byModel so the /usage table
  // can render the column without a second join.
  for (const m of modelMap.values()) {
    const stats = selfCorrAccum.get(m.model);
    if (stats && stats.total > 0) {
      // Rate recomputed from the summed counts, never averaged from per-batch
      // rates — see `selfCorrAccum`.
      m.selfCorrectionRate = stats.corrected / stats.total;
      m.sessionsAsPrimary = stats.total;
    }
  }

  const toolTransitionData = computeToolTransitions(transitionInputs);

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
    totalSessions: sessionIds.size,
    totalTurns: assistantTurnCount,
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
    byEffort: [...effortMap.values()].sort((a, b) => compareEffort(a.effort, b.effort)),
    byEntrypoint: [...entrypointAccum.entries()]
      .map(([entrypoint, v]) => ({
        entrypoint,
        sessions: v.sessions.size,
        turns: v.turns,
        tokens: v.tokens,
        cost: v.cost,
        avgCostPerSession: v.sessions.size > 0 ? v.cost / v.sessions.size : 0,
        backgroundSessions: v.bgSessions.size,
      }))
      .sort((a, b) => compareEntrypoint(a.entrypoint, b.entrypoint)),
    bySkillCost: (() => {
      // All-or-nothing, matching `queryBySkillCost`: any explicit attribution
      // in the period makes the whole list explicit.
      const useExplicit = skillExplicit.size > 0;
      const src = useExplicit ? skillExplicit : skillInferred;
      const method = useExplicit ? ("explicit" as const) : ("inferred" as const);
      return [...src.entries()]
        .map(([skill, a]) => {
          const t = useExplicit ? skillTasks.get(skill) : undefined;
          const verifiedTasks = t?.verified ?? 0;
          const oneShotTasks = t?.oneShot ?? 0;
          return {
            skill, turns: a.turns, tokens: a.tokens, cost: a.cost,
            verifiedTasks, oneShotTasks, method,
            ...(verifiedTasks > 0 ? { oneShotRate: oneShotTasks / verifiedTasks } : {}),
          };
        })
        .sort((a, b) => b.cost - a.cost);
    })(),
    byMcpCost: (() => {
      const useExplicit = mcpExplicit.size > 0;
      const src = useExplicit ? mcpExplicit : mcpInferred;
      const method = useExplicit ? ("explicit" as const) : ("inferred" as const);
      return [...src.entries()]
        .map(([key, a]) => {
          const tools = useExplicit ? mcpTools.get(key) : undefined;
          return {
            server: a.display, key, turns: a.turns, tokens: a.tokens, cost: a.cost, method,
            ...(tools && tools.size > 0
              ? {
                  tools: [...tools.entries()]
                    .map(([tool, t]) => ({ tool, turns: t.turns, cost: t.cost }))
                    .sort((x, y) => y.cost - x.cost),
                }
              : {}),
          };
        })
        .sort((a, b) => b.cost - a.cost);
    })(),
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
    subagentCost,
    subagentTokens,
  };
  }

  return { addTurns, finalize };
}

/**
 * Pure aggregation over a pre-filtered set of turns, resident all at once.
 *
 * The single-batch shape of `createUsageAccumulator`. Kept because the SQL
 * backend hands in turns rehydrated from SQLite and the tests exercise this
 * signature — and because expressing it in terms of the accumulator is what
 * guarantees the two cannot drift.
 */
export async function aggregateUsage(
  turns: UsageTurn[],
  period: Period,
  activity: ActivityData
): Promise<UsageReport> {
  const acc = createUsageAccumulator(period);
  await acc.addTurns(turns);
  return acc.finalize(activity);
}
