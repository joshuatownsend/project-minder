import type { SkillStats, UsageTurn } from "./types";

/**
 * Aggregate Skill calls across the given UsageTurn[].
 *
 * @param turns All parsed JSONL turns.
 * @param sinceMs Optional Unix-ms lower bound. Turns with a timestamp
 *   strictly before this are skipped — matches the SQL `tu.ts >= ?`
 *   predicate on the DB-backed path. Omit for all-time stats.
 */
export function groupSkillCalls(turns: UsageTurn[], sinceMs?: number): SkillStats[] {
  const statsMap = new Map<string, SkillStats>();
  // Per-skill: sessionId → latest timestamp seen in that session (for sort + dedup)
  const sessionTimes = new Map<string, Map<string, string>>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    if (sinceMs !== undefined) {
      const t = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }

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

/**
 * Attach A4 attributed spend to skill stats (file backend).
 *
 * Separate from {@link groupSkillCalls} rather than folded into it, because
 * cost needs pricing — an async, network-or-cache-backed lookup — while that
 * function is a synchronous pass over turns used in several places that have
 * no business awaiting anything. Keeping them apart means the counting path
 * stays cheap and the cost path is opt-in.
 *
 * Mutates and returns `stats` so the caller's ordering is preserved. Skills
 * with attribution but no recorded `Skill` invocation are appended, since a
 * skill can drive spend without inference ever having seen it — that is the
 * whole point of A4.
 */
export function attachSkillAttribution(
  stats: SkillStats[],
  turns: UsageTurn[],
  costOf: (t: UsageTurn) => number,
  sinceMs?: number
): SkillStats[] {
  const acc = new Map<string, { cost: number; turns: number }>();
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const skill = turn.attributionSkill;
    if (typeof skill !== "string" || skill.length === 0) continue;
    if (sinceMs !== undefined) {
      const t = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
    const a = acc.get(skill) ?? { cost: 0, turns: 0 };
    a.cost += costOf(turn);
    a.turns++;
    acc.set(skill, a);
  }
  if (acc.size === 0) return stats;

  const byName = new Map(stats.map((s) => [s.name, s]));
  for (const [name, a] of acc) {
    const existing = byName.get(name);
    if (existing) {
      existing.attributedCostUsd = a.cost;
      existing.attributedTurns = a.turns;
      continue;
    }
    stats.push({
      name,
      invocations: 0,
      projects: {},
      sessions: [],
      attributedCostUsd: a.cost,
      attributedTurns: a.turns,
    });
  }
  return stats;
}
