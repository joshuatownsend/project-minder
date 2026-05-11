import type { AgentStats, UsageTurn } from "./types";

/**
 * Aggregate Agent (subagent) calls across the given UsageTurn[].
 *
 * @param turns All parsed JSONL turns.
 * @param sinceMs Optional Unix-ms lower bound. Turns with a timestamp
 *   strictly before this are skipped — matches the SQL `tu.ts >= ?`
 *   predicate on the DB-backed path. Turns without a parseable
 *   timestamp are skipped under any filter (defensive). Omit for
 *   all-time stats.
 */
export function groupAgentCalls(turns: UsageTurn[], sinceMs?: number): AgentStats[] {
  const statsMap = new Map<string, AgentStats>();
  // Per-agent: sessionId → latest timestamp seen in that session (for sort + dedup)
  const sessionTimes = new Map<string, Map<string, string>>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    if (sinceMs !== undefined) {
      const t = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }

    for (const tc of turn.toolCalls) {
      if (tc.name !== "Agent") continue;
      const agentType = tc.arguments?.subagent_type;
      if (typeof agentType !== "string" || !agentType) continue;

      let stat = statsMap.get(agentType);
      if (!stat) {
        stat = { name: agentType, invocations: 0, projects: {}, sessions: [] };
        statsMap.set(agentType, stat);
        sessionTimes.set(agentType, new Map());
      }

      stat.invocations++;

      if (!stat.firstUsed || turn.timestamp < stat.firstUsed) stat.firstUsed = turn.timestamp;
      if (!stat.lastUsed || turn.timestamp > stat.lastUsed) stat.lastUsed = turn.timestamp;

      stat.projects[turn.projectSlug] = (stat.projects[turn.projectSlug] ?? 0) + 1;

      const times = sessionTimes.get(agentType)!;
      const prev = times.get(turn.sessionId) ?? "";
      if (!turn.timestamp || turn.timestamp > prev) {
        times.set(turn.sessionId, turn.timestamp ?? "");
      }
    }
  }

  const results = Array.from(statsMap.values());
  for (const stat of results) {
    const times = sessionTimes.get(stat.name)!;
    stat.sessions = [...times.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 50)
      .map(([id]) => id);
  }

  return results.sort((a, b) => b.invocations - a.invocations);
}
