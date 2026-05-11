// Period filter shared by /api/agents/[id] and /api/skills/[id]. The
// detail page surfaces a 24h/7d/30d/all toggle on the Usage tab; both
// the DB-backed (loadAgentUsageFromDb / loadSkillUsageFromDb) and
// file-parse (groupAgentCalls / groupSkillCalls) paths consult these
// helpers so the toggle's UI claim ("last 24h") matches whatever
// backend is in use.

export const USAGE_PERIODS = ["24h", "7d", "30d", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

const PERIOD_SET: ReadonlySet<string> = new Set(USAGE_PERIODS);

const MS_BY_PERIOD: Record<Exclude<UsagePeriod, "all">, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return typeof value === "string" && PERIOD_SET.has(value);
}

export function parseUsagePeriod(value: string | null | undefined, fallback: UsagePeriod = "all"): UsagePeriod {
  return isUsagePeriod(value) ? value : fallback;
}

/** Convert a period to an ISO8601 lower-bound (or null for "all").
 *  Caller is expected to filter `tu.ts >= <returned-ISO>`. ISO8601 sorts
 *  lexicographically so the predicate works against the TEXT column. */
export function periodSinceIso(period: UsagePeriod, now: Date = new Date()): string | null {
  if (period === "all") return null;
  return new Date(now.getTime() - MS_BY_PERIOD[period]).toISOString();
}

/** Convert a period to a Unix-ms lower bound (or null for "all"), for
 *  the file-parse path which already has timestamps as strings but
 *  compares via Date.parse rather than lexicographic ordering. */
export function periodSinceMs(period: UsagePeriod, now: Date = new Date()): number | null {
  if (period === "all") return null;
  return now.getTime() - MS_BY_PERIOD[period];
}
