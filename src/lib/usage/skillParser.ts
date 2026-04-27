import type { SkillStats, UsageTurn } from "./types";

export function groupSkillCalls(turns: UsageTurn[]): SkillStats[] {
  const statsMap = new Map<string, SkillStats>();
  // Per-skill: sessionId → latest timestamp seen in that session (for sort + dedup)
  const sessionTimes = new Map<string, Map<string, string>>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;

    for (const tc of turn.toolCalls) {
      if (tc.name !== "Skill") continue;
      const skillName = tc.arguments?.skill;
      if (typeof skillName !== "string" || !skillName) continue;

      let stat = statsMap.get(skillName);
      if (!stat) {
        stat = { name: skillName, invocations: 0, projects: {}, sessions: [] };
        statsMap.set(skillName, stat);
        sessionTimes.set(skillName, new Map());
      }

      stat.invocations++;

      if (!stat.firstUsed || turn.timestamp < stat.firstUsed) stat.firstUsed = turn.timestamp;
      if (!stat.lastUsed || turn.timestamp > stat.lastUsed) stat.lastUsed = turn.timestamp;

      stat.projects[turn.projectSlug] = (stat.projects[turn.projectSlug] ?? 0) + 1;

      const times = sessionTimes.get(skillName)!;
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
