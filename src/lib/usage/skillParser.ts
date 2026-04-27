import type { SkillStats, UsageTurn } from "./types";

export function groupSkillCalls(turns: UsageTurn[]): SkillStats[] {
  const statsMap = new Map<string, SkillStats>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;

    for (const tc of turn.toolCalls) {
      if (tc.name !== "Skill") continue;
      const skillName = tc.arguments?.skill;
      if (typeof skillName !== "string" || !skillName) continue;

      let stat = statsMap.get(skillName);
      if (!stat) {
        stat = {
          name: skillName,
          invocations: 0,
          projects: {},
          sessions: [],
        };
        statsMap.set(skillName, stat);
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

  const results = Array.from(statsMap.values());
  for (const stat of results) {
    stat.sessions.sort((a, b) => b.localeCompare(a));
    if (stat.sessions.length > 50) stat.sessions = stat.sessions.slice(0, 50);
  }

  return results.sort((a, b) => b.invocations - a.invocations);
}
