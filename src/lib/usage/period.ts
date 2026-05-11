// Thin Phase 4.1 wrappers over the canonical period helpers
// (`constants.ts` for the type + validator, `periods.ts` for the
// boundary computation, `usageFromDb.ts:periodStartIso` for the SQL
// shape). Existed pre-consolidation as its own vocabulary — now just
// adapts the canonical pieces for the agent/skill detail route, which
// uses a 4-option subset (24h / 7d / 30d / all) of the 5-option app
// vocabulary.

import type { Period } from "./constants";
import { VALID_PERIODS, validatePeriod } from "./constants";
import { getPeriodStart } from "./periods";

export type UsagePeriod = Period;

/** The subset rendered on the agent/skill detail toggle. The app's full
 *  vocabulary in `VALID_PERIODS` also includes "today" (calendar) — the
 *  detail page intentionally shows rolling-24h instead because users land
 *  there asking "did I invoke this in the last day?" and a calendar-aligned
 *  "today" is misleading at 1am. */
export const DETAIL_PERIODS = VALID_PERIODS.filter((p) => p.value !== "today");

const NO_PARAM_FALLBACK: Period = "all";

/** Parse a `?period=` query-string value into a `Period`. When the param
 *  is absent the call site's preferred default is honored (the detail
 *  route defaults to "all" so first-load behavior matches pre-Phase 4.1).
 *  When the param is junk, delegates to `validatePeriod`'s "30d" fallback. */
export function parseUsagePeriod(value: string | null | undefined, fallback: Period = NO_PARAM_FALLBACK): Period {
  if (value == null || value === "") return fallback;
  return validatePeriod(value);
}

/** Period → ISO8601 lower bound, or null for "all". Wrapper around
 *  `getPeriodStart` so the SQL-side caller and the file-parse-side caller
 *  agree on the same boundary for the same period+now. */
export function periodSinceIso(period: Period, now: Date = new Date()): string | null {
  return getPeriodStart(period, now)?.toISOString() ?? null;
}

/** Period → Unix-ms lower bound, or null for "all". The file-parse path
 *  compares `UsageTurn.timestamp` via `Date.parse` and wants ms, while
 *  the SQL path compares `tu.ts` TEXT and wants ISO — they're both
 *  derived from the same `getPeriodStart` result so they're guaranteed
 *  to agree for the same `now`. */
export function periodSinceMs(period: Period, now: Date = new Date()): number | null {
  return getPeriodStart(period, now)?.getTime() ?? null;
}
