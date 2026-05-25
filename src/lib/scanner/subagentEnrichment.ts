import "server-only";
import type { SubagentInfo } from "@/lib/types";

// Per-subagent runtime metrics, enriched from OTEL events.
//
// As of Claude Code ~v2.1.150 the JSONL schema no longer carries sidechain
// assistant entries with `parentToolUseID` linkage (probed 2026-05-25: 0/214
// sessions). The legacy `agentCost.ts` portfolio cost roll-up returns $0
// across all agents as a result (tracked separately).
//
// OTEL retains the data we need:
//   - `subagent_completed` events carry one row per agent invocation with
//     `agent_type`, `prompt.id`, `total_tool_uses`, `duration_ms`, `model`,
//     and `total_tokens` (sum of input+output, no I/O split).
//   - `api_request` events tag each API call with `prompt.id` and carry
//     exact `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
//     `cache_creation_tokens`. Summing api_request by prompt.id gives the
//     authoritative cost without an I/O ratio assumption.
//
// Match strategy: subagent_completed orders give us the chronological list
// of invocations per (session_id, agent_type). The JSONL Agent dispatches
// in `SubagentInfo[]` are likewise discovered in chronological order. So we
// match the n-th JSONL dispatch of type T to the n-th OTEL completion of
// type T in the same session. Excess JSONL dispatches (no matching OTEL
// completion — e.g. in-flight or crashed agents) keep undefined metric
// fields; excess OTEL completions (no matching JSONL — corrupted scan) are
// dropped.

interface SubagentCompletion {
  promptId: string;
  agentType: string;
  totalToolUses: number;
  durationMs: number;
  model: string;
  totalTokens: number;
  eventTimestamp: string;
}

interface ApiRequestRollup {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * Populate runtime fields on `subagents` from OTEL events for the given
 * session. Mutates the passed array in place. Best-effort — silently no-ops
 * when the SQLite driver isn't loaded, the DB is missing, or no OTEL data
 * exists for the session.
 */
export async function enrichSubagentsFromOtel(
  sessionId: string,
  subagents: SubagentInfo[],
): Promise<void> {
  if (subagents.length === 0) return;

  // Dynamic import so the scanner module doesn't statically require the
  // db connection module — `tests/dataSessionDetail.test.ts` already
  // exercises a path where better-sqlite3 may not be loadable.
  let db: import("better-sqlite3").Database | null = null;
  try {
    const { getDb } = await import("@/lib/db/connection");
    db = await getDb();
  } catch {
    return;
  }
  if (!db) return;

  let completions: SubagentCompletion[];
  let apiRequests: Map<string, ApiRequestRollup>;
  try {
    completions = querySubagentCompletions(db, sessionId);
    apiRequests = queryApiRequestsBySession(db, sessionId);
  } catch {
    // OTEL tables may not exist on a fresh install — same fallback shape.
    return;
  }
  if (completions.length === 0) return;

  // Group completions by agent_type, preserving chronological order.
  const completionsByType = new Map<string, SubagentCompletion[]>();
  for (const c of completions) {
    const list = completionsByType.get(c.agentType) ?? [];
    list.push(c);
    completionsByType.set(c.agentType, list);
  }

  // Counter per type so we pick the correct n-th completion as we walk
  // the JSONL-discovered Agent dispatches (also in chronological order).
  const typeCounters = new Map<string, number>();
  for (const agent of subagents) {
    const idx = typeCounters.get(agent.type) ?? 0;
    typeCounters.set(agent.type, idx + 1);
    const completion = completionsByType.get(agent.type)?.[idx];
    if (!completion) continue;

    agent.model = completion.model;
    agent.durationMs = completion.durationMs;
    agent.lastTimestamp = completion.eventTimestamp;
    if (completion.durationMs > 0) {
      agent.firstTimestamp = new Date(
        new Date(completion.eventTimestamp).getTime() - completion.durationMs,
      ).toISOString();
    }

    const rollup = apiRequests.get(completion.promptId);
    if (rollup) {
      agent.costUsd = rollup.costUsd;
      agent.inputTokens = rollup.inputTokens;
      agent.outputTokens = rollup.outputTokens;
      agent.cacheReadTokens = rollup.cacheReadTokens;
      agent.cacheCreateTokens = rollup.cacheCreateTokens;
    } else {
      // No api_request rollup available — fall back to subagent_completed's
      // total_tokens. Cost stays undefined since we can't reliably split
      // input/output for pricing.
      agent.inputTokens = completion.totalTokens;
    }
  }
}

function querySubagentCompletions(
  db: import("better-sqlite3").Database,
  sessionId: string,
): SubagentCompletion[] {
  // OTEL attrs in `otel_events.payload_json` follow the shape `{ attrs: {...} }`.
  // Numeric attrs arrive as strings via the OTEL JS SDK (stringValue); cast.
  const rows = db.prepare(`
    SELECT
      json_extract(payload_json, '$.attrs."prompt.id"')          AS promptId,
      json_extract(payload_json, '$.attrs.agent_type')           AS agentType,
      CAST(json_extract(payload_json, '$.attrs.total_tool_uses') AS INTEGER) AS totalToolUses,
      CAST(json_extract(payload_json, '$.attrs.duration_ms')     AS INTEGER) AS durationMs,
      json_extract(payload_json, '$.attrs.model')                AS model,
      CAST(json_extract(payload_json, '$.attrs.total_tokens')    AS INTEGER) AS totalTokens,
      ts                                                          AS eventTimestamp
    FROM otel_events
    WHERE event_name = 'subagent_completed'
      AND json_extract(payload_json, '$.attrs."session.id"') = ?
    ORDER BY ts ASC
  `).all(sessionId) as Array<{
    promptId: string | null;
    agentType: string | null;
    totalToolUses: number | null;
    durationMs: number | null;
    model: string | null;
    totalTokens: number | null;
    eventTimestamp: string;
  }>;
  return rows
    .filter((r) => r.agentType !== null && r.promptId !== null)
    .map((r) => ({
      promptId: r.promptId!,
      agentType: r.agentType!,
      totalToolUses: r.totalToolUses ?? 0,
      durationMs: r.durationMs ?? 0,
      model: r.model ?? "",
      totalTokens: r.totalTokens ?? 0,
      eventTimestamp: r.eventTimestamp,
    }));
}

function queryApiRequestsBySession(
  db: import("better-sqlite3").Database,
  sessionId: string,
): Map<string, ApiRequestRollup> {
  // Pre-aggregate by prompt.id in SQL to keep the JS layer small.
  // cost_usd in api_request is a real number (not stringified) per the
  // OTEL metrics SDK; input/output/cache token attrs may be strings.
  const rows = db.prepare(`
    SELECT
      json_extract(payload_json, '$.attrs."prompt.id"')                   AS promptId,
      SUM(CAST(json_extract(payload_json, '$.attrs.cost_usd') AS REAL))   AS costUsd,
      SUM(CAST(json_extract(payload_json, '$.attrs.input_tokens') AS INTEGER))  AS inputTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.output_tokens') AS INTEGER)) AS outputTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.cache_read_tokens') AS INTEGER))     AS cacheReadTokens,
      SUM(CAST(json_extract(payload_json, '$.attrs.cache_creation_tokens') AS INTEGER)) AS cacheCreateTokens
    FROM otel_events
    WHERE event_name = 'api_request'
      AND json_extract(payload_json, '$.attrs."session.id"') = ?
    GROUP BY json_extract(payload_json, '$.attrs."prompt.id"')
  `).all(sessionId) as Array<{
    promptId: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreateTokens: number | null;
  }>;
  const result = new Map<string, ApiRequestRollup>();
  for (const r of rows) {
    if (!r.promptId) continue;
    result.set(r.promptId, {
      costUsd: r.costUsd ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheCreateTokens: r.cacheCreateTokens ?? 0,
    });
  }
  return result;
}
