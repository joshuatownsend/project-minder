import "server-only";
import type { SubagentInfo } from "@/lib/types";
import {
  computeAgentCostInvocationsFromOtel,
  type AgentCostInvocation,
} from "@/lib/usage/agentCostFromOtel";

// Per-subagent runtime metrics, enriched from OTEL events.
//
// As of Claude Code ~v2.1.150 the JSONL schema no longer carries
// sidechain assistant entries with `parentToolUseID` linkage (probed
// 2026-05-25: 0/214 sessions). This enrichment is the working
// replacement.
//
// **Cost attribution.** Cost comes from
// `computeAgentCostInvocationsFromOtel` (see that module's header for
// the matched-set proportional-distribution rule). A single api_request
// `prompt.id` is shared across every subagent in a parallel-dispatch
// turn AND across the parent main-thread Claude turns, so we can't
// just look up "this invocation's cost by prompt.id" — the util walks
// `api_request.query_source` to split correctly.
//
// **Matching JSONL → OTEL.** The JSONL `Agent` dispatches in
// `SubagentInfo[]` arrive in chronological order; `AgentCostInvocation`
// rows from the util are also chronological (ORDER BY ts ASC per
// session). We match the n-th JSONL dispatch of type T to the n-th OTEL
// invocation of type T. Excess JSONL dispatches (no matching OTEL
// invocation — e.g. in-flight or crashed agents) keep undefined metric
// fields; excess OTEL invocations (no matching JSONL — corrupted scan)
// are dropped.

/**
 * Populate runtime fields on `subagents` from OTEL events for the given
 * session. Mutates the passed array in place. Best-effort — silently
 * no-ops when the SQLite driver isn't loaded, the DB is missing, or no
 * OTEL data exists for the session.
 */
export async function enrichSubagentsFromOtel(
  sessionId: string,
  subagents: SubagentInfo[],
): Promise<void> {
  if (subagents.length === 0) return;

  // `null` signals OTEL read failure (driver missing, query threw on a
  // partially-migrated schema). No-op rather than mutating the SubagentInfo
  // array — the JSONL-derived skeleton still renders without runtime chips.
  const invocations = await computeAgentCostInvocationsFromOtel({ sessionId });
  if (invocations === null || invocations.length === 0) return;

  // Group invocations by agent_type, preserving chronological order
  // (the underlying SQL returned them sorted by ts ASC).
  const invocationsByType = new Map<string, AgentCostInvocation[]>();
  for (const inv of invocations) {
    const list = invocationsByType.get(inv.agentType) ?? [];
    list.push(inv);
    invocationsByType.set(inv.agentType, list);
  }

  // Counter per type so we pick the correct n-th invocation as we walk
  // the JSONL-discovered Agent dispatches (also in chronological order).
  const typeCounters = new Map<string, number>();
  for (const agent of subagents) {
    const idx = typeCounters.get(agent.type) ?? 0;
    typeCounters.set(agent.type, idx + 1);
    const inv = invocationsByType.get(agent.type)?.[idx];
    if (!inv) continue;

    agent.model = inv.model || undefined;
    agent.durationMs = inv.durationMs || undefined;
    agent.lastTimestamp = inv.endTs;
    if (inv.durationMs > 0) {
      agent.firstTimestamp = new Date(
        new Date(inv.endTs).getTime() - inv.durationMs,
      ).toISOString();
    }

    // `costUsd` is the post-distribution per-invocation share, not the
    // raw prompt.id total — writing it raw here is correct. Token
    // shares are fractional in `inv` (the util defers rounding to
    // consumption sites); display layers want integers, so round here.
    // The condition includes cache tokens (Copilot review: a cache-
    // heavy turn with zero input/output should still surface).
    const hasAnyCostOrTokens =
      inv.costUsd          > 0 ||
      inv.inputTokens      > 0 ||
      inv.outputTokens     > 0 ||
      inv.cacheReadTokens  > 0 ||
      inv.cacheCreateTokens > 0;
    if (hasAnyCostOrTokens) {
      agent.costUsd           = inv.costUsd;
      agent.inputTokens       = Math.round(inv.inputTokens);
      agent.outputTokens      = Math.round(inv.outputTokens);
      agent.cacheReadTokens   = Math.round(inv.cacheReadTokens);
      agent.cacheCreateTokens = Math.round(inv.cacheCreateTokens);
    } else if (inv.totalTokens > 0) {
      // No matching `agent:*` api_request rows distributed any cost to
      // this invocation. Surface the rollup-only `total_tokens` under a
      // dedicated field so consumers don't mistake it for an input/output
      // value. Cost stays undefined since we can't reliably split I/O
      // for pricing without api_request rows.
      agent.totalTokens = inv.totalTokens;
    }
  }
}
