import type { AgentStats, UsageTurn } from "./types";

export function groupAgentCalls(turns: UsageTurn[]): AgentStats[] {
  const statsMap = new Map<string, AgentStats>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;

    for (const tc of turn.toolCalls) {
      if (tc.name !== "Agent") continue;
      const agentType = tc.arguments?.subagent_type;
      if (typeof agentType !== "string" || !agentType) continue;

      let stat = statsMap.get(agentType);
      if (!stat) {
        stat = {
          name: agentType,
          invocations: 0,
          projects: {},
          sessions: [],
        };
        statsMap.set(agentType, stat);
      }

      stat.invocations++;

      if (!stat.firstUsed || turn.timestamp < stat.firstUsed) {
        stat.firstUsed = turn.timestamp;
      }
      if (!stat.lastUsed || turn.timestamp > stat.lastUsed) {
        stat.lastUsed = turn.timestamp;
      }

      stat.projects[turn.projectSlug] = (stat.projects[turn.projectSlug] ?? 0) + 1;

      if (!stat.sessions.includes(turn.sessionId)) {
        stat.sessions.push(turn.sessionId);
      }
    }
  }

  // Sort each stats entry's sessions by most recent (desc) and cap at 50
  const results = Array.from(statsMap.values());
  for (const stat of results) {
    stat.sessions.sort((a, b) => b.localeCompare(a));
    if (stat.sessions.length > 50) stat.sessions = stat.sessions.slice(0, 50);
  }

  return results.sort((a, b) => b.invocations - a.invocations);
}
