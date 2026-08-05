import type { UsageTurn } from "./types";

/**
 * Bucket for turns that carry no `effort`. Two distinct situations land here
 * and neither is a value:
 *
 *   - the transcript predates the field (Claude Code < ~2.1.212), and
 *   - the ~4% of recent assistant turns that omit it (the same turns whose
 *     `usage.speed` is null).
 *
 * A third, temporary case: rows indexed before the A1 re-parse read as NULL
 * too. That equivalence is deliberate — see `derivationVersion.ts` v13.
 *
 * It is a real bucket, not a default. Folding it into `medium` would invent a
 * reasoning level for the majority of this corpus's history, and dropping it
 * would silently shrink the denominator of every rate on the page.
 */
export const UNKNOWN_EFFORT = "unknown";

/**
 * Display order for effort buckets: the ordinal scale ascending, then unknown.
 *
 * `byEffort` is deliberately NOT sorted by cost the way `byModel` and
 * `byCategory` are. Effort is ordinal, so a chart whose bars reorder between
 * periods destroys the only comparison the chart exists to make — whether the
 * line trends up or down as effort rises.
 *
 * `low` is documented by Claude Code but unobserved in this corpus; it is
 * listed so it sorts correctly the first time one appears rather than being
 * treated as unrecognized.
 */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", UNKNOWN_EFFORT] as const;

const EFFORT_RANK = new Map<string, number>(EFFORT_ORDER.map((e, i) => [e, i]));

/**
 * Map a raw `turns.effort` value to its bucket key. Absent, null, and empty
 * all collapse to {@link UNKNOWN_EFFORT}; any unrecognized non-empty value is
 * passed through verbatim rather than swallowed, so a future Claude Code
 * effort level shows up as its own bucket instead of vanishing into unknown.
 */
export function effortBucket(effort: string | null | undefined): string {
  return effort ? effort : UNKNOWN_EFFORT;
}

/**
 * Sort comparator for effort bucket keys. Known levels sort by the ordinal
 * scale; unrecognized levels sort after `unknown`, alphabetically, so their
 * order is at least stable.
 */
export function compareEffort(a: string, b: string): number {
  const ra = EFFORT_RANK.get(a) ?? EFFORT_ORDER.length;
  const rb = EFFORT_RANK.get(b) ?? EFFORT_ORDER.length;
  return ra === rb ? a.localeCompare(b) : ra - rb;
}

/**
 * Per-session effort histogram — the shape behind the session effort chip.
 *
 * Counts only turns that HAVE an effort, so it deliberately does not sum to
 * the session's assistant-turn count, and returns `undefined` when none do.
 * An empty object would render as "0 high-effort turns" for a session that
 * could not have reported any; absence has to stay distinguishable.
 */
export function computeEffortMix(
  turns: Pick<UsageTurn, "role" | "effort">[]
): Record<string, number> | undefined {
  const mix: Record<string, number> = {};
  let seen = 0;
  for (const t of turns) {
    if (t.role !== "assistant" || !t.effort) continue;
    mix[t.effort] = (mix[t.effort] ?? 0) + 1;
    seen++;
  }
  return seen > 0 ? mix : undefined;
}
