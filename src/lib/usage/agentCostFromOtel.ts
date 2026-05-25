import "server-only";

// Per-invocation agent cost attribution, derived from OTEL events.
//
// **The data shape problem.** Claude Code's OTEL emitter tags every
// `api_request` event with a `prompt.id` that identifies the user-turn
// the call belongs to — NOT the specific subagent invocation. When a
// user prompt fans out into N parallel subagent dispatches, every
// `api_request` from any of those subagents (and from the main thread)
// carries the SAME `prompt.id`. So `subagent_completed.prompt.id`
// alone can't be used to look up "this invocation's cost" — both the
// parent prompt's main-thread Claude turns AND every sibling
// subagent's calls share the prompt.id.
//
// **The disambiguator.** `api_request.query_source` reveals the
// per-call attribution:
//
//   - `repl_main_thread`               — main session (not a subagent)
//   - `agent:builtin:general-purpose`  — built-in `general-purpose` agent
//   - `agent:builtin:Explore`          — built-in `Explore` agent
//   - `agent:custom`                   — any user-defined agent (.md file)
//   - `web_search_tool`, `compact`, `away_summary`, …  — utility paths
//
// **The attribution rule.** Within a single prompt.id with K
// `subagent_completed` invocations:
//
//   1. Find the set of *builtin* agent types referenced by any
//      `agent:builtin:X` cost in this prompt — call this `B`.
//   2. For every `api_request` row in this prompt:
//        - `agent:builtin:X`: matched set = invocations where
//          `agent_type = X`. The X comes from the row itself, NOT B.
//        - `agent:custom`:    matched set = invocations whose
//          `agent_type` is NOT in B (i.e., user-defined agents).
//        - anything else:     skip (not subagent cost).
//   3. Distribute the row's cost across its matched set in proportion
//      to each invocation's `total_tokens`. When the matched-set
//      `total_tokens` sum is 0, the row is dropped (defensive — we
//      have no signal to split it).
//
// The proportional rule is correct in three regimes:
//   - Single invocation in the matched set → share = 1.0 (exact).
//   - K invocations of the same type      → each gets share by tokens
//     (e.g., 6× `general-purpose` in one prompt, see PR #163 probe).
//   - Parallel mixed types                 → each gets share by tokens
//     across the K-element subset (`gsd-executor + gsd-verifier`).
//
// **Why this matters.** Issue #161 — `agentCost.ts` returned $0 for
// every agent because the JSONL sidechain schema went away. T1.2's
// per-session subagent enrichment had a sibling bug: it pulled cost
// by prompt.id without distributing, so every one of 18 parallel
// agents in a single dispatch turn showed the full turn's $77.98.
// This module replaces both code paths with the same util.

interface OtelInvocationRow {
  promptId: string;
  agentType: string;
  totalTokens: number;
  durationMs: number;
  model: string;
  eventTimestamp: string;
  sessionId: string;
}

interface OtelCostRow {
  promptId: string;
  querySource: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface AgentCostInvocation {
  agentType: string;
  sessionId: string;
  promptId: string;
  endTs: string;
  model: string;
  durationMs: number;
  totalTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface AgentCostByType {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  invocations: number;
}

export interface AgentCostFromOtelOpts {
  /** Restrict to a single Claude Code session. Omit for portfolio-wide. */
  sessionId?: string;
}

/**
 * Compute per-invocation agent cost from OTEL events. Best-effort —
 * returns `[]` when the SQLite driver isn't loaded, the connection
 * can't open, or the events tables are missing/empty.
 *
 * Each returned row corresponds to exactly one `subagent_completed`
 * event; sibling invocations sharing a prompt.id appear as separate
 * rows with the cost split proportionally per the rules in the file
 * header.
 */
export async function computeAgentCostInvocationsFromOtel(
  opts: AgentCostFromOtelOpts = {},
): Promise<AgentCostInvocation[]> {
  let db: import("better-sqlite3").Database | null = null;
  try {
    const { getDb } = await import("@/lib/db/connection");
    db = await getDb();
  } catch {
    return [];
  }
  if (!db) return [];

  let invocations: OtelInvocationRow[];
  let costs: OtelCostRow[];
  try {
    invocations = querySubagentInvocations(db, opts.sessionId);
    costs = queryAgentCosts(db, opts.sessionId);
  } catch {
    return [];
  }
  if (invocations.length === 0) return [];

  // Group invocations by prompt.id, preserving chronological order
  // (the SQL ORDER BY ts handles this).
  const byPrompt = new Map<string, OtelInvocationRow[]>();
  for (const inv of invocations) {
    const list = byPrompt.get(inv.promptId) ?? [];
    list.push(inv);
    byPrompt.set(inv.promptId, list);
  }

  // Group cost rows by prompt.id.
  const costsByPrompt = new Map<string, OtelCostRow[]>();
  for (const c of costs) {
    const list = costsByPrompt.get(c.promptId) ?? [];
    list.push(c);
    costsByPrompt.set(c.promptId, list);
  }

  // Seed result rows in the same chronological order as `invocations`.
  // Cost accumulators start at zero and are added to as we walk
  // each prompt's cost rows. A pointer Map<invocationRow, resultRow>
  // lets us write back to the right row even though we iterate by
  // prompt below.
  const resultByInvocation = new Map<OtelInvocationRow, AgentCostInvocation>();
  const results: AgentCostInvocation[] = [];
  for (const inv of invocations) {
    const row: AgentCostInvocation = {
      agentType: inv.agentType,
      sessionId: inv.sessionId,
      promptId: inv.promptId,
      endTs: inv.eventTimestamp,
      model: inv.model,
      durationMs: inv.durationMs,
      totalTokens: inv.totalTokens,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    resultByInvocation.set(inv, row);
    results.push(row);
  }

  // Walk each prompt and distribute its agent:* cost rows across the
  // appropriate matched set of invocations.
  for (const [promptId, promptInvocations] of byPrompt) {
    const promptCosts = costsByPrompt.get(promptId) ?? [];
    if (promptCosts.length === 0) continue;

    // Derive the set of *builtin* agent types referenced in this
    // prompt's cost rows. `agent:custom` invocations are by definition
    // those whose agent_type is NOT one of these.
    const builtinTypes = new Set<string>();
    for (const c of promptCosts) {
      if (c.querySource.startsWith("agent:builtin:")) {
        builtinTypes.add(c.querySource.slice("agent:builtin:".length));
      }
    }

    for (const cost of promptCosts) {
      let matchedSet: OtelInvocationRow[];
      if (cost.querySource === "agent:custom") {
        matchedSet = promptInvocations.filter(
          (inv) => !builtinTypes.has(inv.agentType),
        );
      } else if (cost.querySource.startsWith("agent:builtin:")) {
        const targetType = cost.querySource.slice("agent:builtin:".length);
        matchedSet = promptInvocations.filter(
          (inv) => inv.agentType === targetType,
        );
      } else {
        // Includes `repl_main_thread` and ancillary sources — not
        // attributable to a subagent.
        continue;
      }

      if (matchedSet.length === 0) continue;
      const tokenSum = matchedSet.reduce((acc, inv) => acc + inv.totalTokens, 0);
      if (tokenSum === 0) continue;

      for (const inv of matchedSet) {
        const share = inv.totalTokens / tokenSum;
        const row = resultByInvocation.get(inv)!;
        row.costUsd          += cost.costUsd          * share;
        row.inputTokens      += cost.inputTokens      * share;
        row.outputTokens     += cost.outputTokens     * share;
        row.cacheReadTokens  += cost.cacheReadTokens  * share;
        row.cacheCreateTokens += cost.cacheCreateTokens * share;
      }
    }
  }

  // Token shares stay fractional here — rounding each invocation
  // independently introduces drift (6 rounded shares of 12000 can sum
  // to 12001). Consumers round at display time; the aggregator below
  // sums then rounds so portfolio totals stay exact.
  return results;
}

/**
 * Roll up per-invocation cost into a per-agent-type Map. Used by
 * `/api/agents` and friends for the portfolio cost column.
 *
 * Invocations are counted via the number of `subagent_completed`
 * events. A row whose distributed cost ended up as zero (e.g., its
 * prompt had no `agent:*` api_request rows) is still counted as an
 * invocation — same shape as the legacy `agentCost.ts` behavior.
 */
export function aggregateAgentCostByType(
  invocations: AgentCostInvocation[],
): Map<string, AgentCostByType> {
  const result = new Map<string, AgentCostByType>();
  for (const inv of invocations) {
    const existing = result.get(inv.agentType) ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      invocations: 0,
    };
    existing.costUsd      += inv.costUsd;
    existing.inputTokens  += inv.inputTokens;
    existing.outputTokens += inv.outputTokens;
    existing.invocations  += 1;
    result.set(inv.agentType, existing);
  }
  // Round AFTER summing so the per-agent totals stay close to the
  // un-distributed source totals (per-invocation rounding can drift
  // by up to K tokens, K = invocation count).
  for (const entry of result.values()) {
    entry.inputTokens  = Math.round(entry.inputTokens);
    entry.outputTokens = Math.round(entry.outputTokens);
  }
  return result;
}

// ── SQL helpers ────────────────────────────────────────────────────

function querySubagentInvocations(
  db: import("better-sqlite3").Database,
  sessionId?: string,
): OtelInvocationRow[] {
  const whereParts: string[] = [`event_name = 'subagent_completed'`];
  const params: unknown[] = [];
  if (sessionId) {
    whereParts.push(`session_id = ?`);
    params.push(sessionId);
  }
  const rows = db.prepare(`
    SELECT
      json_extract(payload_json, '$.attrs."prompt.id"')                AS promptId,
      json_extract(payload_json, '$.attrs.agent_type')                 AS agentType,
      CAST(json_extract(payload_json, '$.attrs.total_tokens') AS INTEGER) AS totalTokens,
      CAST(json_extract(payload_json, '$.attrs.duration_ms')  AS INTEGER) AS durationMs,
      json_extract(payload_json, '$.attrs.model')                       AS model,
      ts                                                                  AS eventTimestamp,
      session_id                                                          AS sessionId
    FROM otel_events
    WHERE ${whereParts.join(" AND ")}
    ORDER BY ts ASC
  `).all(...params) as Array<{
    promptId: string | null;
    agentType: string | null;
    totalTokens: number | null;
    durationMs: number | null;
    model: string | null;
    eventTimestamp: string;
    sessionId: string | null;
  }>;
  return rows
    .filter((r) => r.promptId !== null && r.agentType !== null && r.sessionId !== null)
    .map((r) => ({
      promptId: r.promptId!,
      agentType: r.agentType!,
      totalTokens: r.totalTokens ?? 0,
      durationMs: r.durationMs ?? 0,
      model: r.model ?? "",
      eventTimestamp: r.eventTimestamp,
      sessionId: r.sessionId!,
    }));
}

function queryAgentCosts(
  db: import("better-sqlite3").Database,
  sessionId?: string,
): OtelCostRow[] {
  // Pre-aggregate by (prompt.id, query_source) in SQL — keeps the JS
  // distribution loop small and avoids carrying thousands of individual
  // api_request rows into memory.
  //
  // Filter to `agent:%` query_sources only — `repl_main_thread` and
  // ancillary sources (`compact`, `away_summary`, etc.) are not
  // subagent cost.
  const whereParts: string[] = [
    `event_name = 'api_request'`,
    `json_extract(payload_json, '$.attrs.query_source') LIKE 'agent:%'`,
  ];
  const params: unknown[] = [];
  if (sessionId) {
    whereParts.push(`session_id = ?`);
    params.push(sessionId);
  }
  const rows = db.prepare(`
    SELECT
      json_extract(payload_json, '$.attrs."prompt.id"')                          AS promptId,
      json_extract(payload_json, '$.attrs.query_source')                         AS querySource,
      SUM(CAST(json_extract(payload_json, '$.attrs.cost_usd')             AS REAL))    AS costUsd,
      SUM(CAST(json_extract(payload_json, '$.attrs.input_tokens')         AS INTEGER)) AS inputTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.output_tokens')        AS INTEGER)) AS outputTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.cache_read_tokens')    AS INTEGER)) AS cacheReadTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.cache_creation_tokens') AS INTEGER)) AS cacheCreateTokens
    FROM otel_events
    WHERE ${whereParts.join(" AND ")}
    GROUP BY promptId, querySource
  `).all(...params) as Array<{
    promptId: string | null;
    querySource: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreateTokens: number | null;
  }>;
  return rows
    .filter((r) => r.promptId !== null && r.querySource !== null)
    .map((r) => ({
      promptId: r.promptId!,
      querySource: r.querySource!,
      costUsd: r.costUsd ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheCreateTokens: r.cacheCreateTokens ?? 0,
    }));
}
