import "server-only";
import {
  computeAgentCostInvocationsFromOtel,
  aggregateAgentCostByType,
} from "./agentCostFromOtel";

// Portfolio-level per-agent cost.
//
// Pre-PR-#163 this module walked `~/.claude/projects/**/*.jsonl` and
// accumulated cost from sidechain assistant entries linked via
// `parentToolUseID`. Claude Code dropped sidechain entries from the
// parent session JSONL (probed 2026-05-25: 0/214 sessions retained
// any sidechain assistants), making that path return $0 for every
// agent (issue #161). The replacement reads OTEL `subagent_completed`
// + `api_request` events — see `agentCostFromOtel.ts` for the
// matched-set proportional-distribution rule that handles
// parallel-dispatch turns correctly.
//
// **Coverage caveat.** OTEL emission is only present in sessions
// run with `OTEL_EXPORTER_OTLP_ENDPOINT` configured. Pre-OTEL
// sessions (most of any user's history) have no cost data to
// recover. The `/agents` UI surface notes this.

export interface AgentCostEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const globalForAgentCost = globalThis as unknown as {
  __agentCostCache?: { map: Map<string, AgentCostEntry>; expiresAt: number };
};

/**
 * Compute per-agent cost across all OTEL-equipped sessions. Returns a
 * Map keyed by `agent_type` (the same string Claude Code emits as
 * `subagent_completed.agent_type`, which matches `AgentEntry.name`
 * once aliased via `buildAgentAliasMap`).
 *
 * Cached in `globalThis` for 2 minutes — keeps per-request load on
 * `/api/agents` cheap. The cache invalidates implicitly by TTL; an
 * explicit invalidation hook isn't needed because new OTEL events
 * are appended out-of-band by the ingest worker and a 2-min
 * staleness on a portfolio analytics column is fine.
 */
export async function computeAgentCostFromFiles(): Promise<Map<string, AgentCostEntry>> {
  // Function name retained for back-compat with `data/index.ts`
  // imports; the implementation no longer touches the filesystem.
  const now = Date.now();
  const cached = globalForAgentCost.__agentCostCache;
  if (cached && now < cached.expiresAt) return cached.map;

  const invocations = await computeAgentCostInvocationsFromOtel();

  // `null` signals an OTEL read failure (driver missing, query threw).
  // Returning an empty Map is the right user-facing answer (chip absent),
  // but writing it into the 2-minute cache would lock the dashboard
  // into the failure state long after the DB recovers. Return without
  // caching so the next call retries.
  if (invocations === null) return new Map();

  const rollup = aggregateAgentCostByType(invocations);

  // Project the richer rollup down to the (costUsd, inputTokens,
  // outputTokens) triple the existing call site
  // (`mergeAgentCost` in data/index.ts) expects. Invocation counts
  // surface separately through the indexed `tool_uses`-based
  // `AgentStats.invocations` field — re-emitting them here would
  // duplicate that signal.
  const result = new Map<string, AgentCostEntry>();
  for (const [agentType, entry] of rollup) {
    if (entry.costUsd === 0 && entry.inputTokens === 0 && entry.outputTokens === 0) {
      continue;
    }
    result.set(agentType, {
      costUsd: entry.costUsd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    });
  }

  globalForAgentCost.__agentCostCache = { map: result, expiresAt: now + 120_000 };
  return result;
}
