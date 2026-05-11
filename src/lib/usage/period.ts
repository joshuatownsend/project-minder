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

/** Same as `Period` but also includes legacy aliases. `getPeriodStart`
 *  accepts these (week→7d, month→30d) so callers that historically
 *  threaded them through (aggregator, file-parse usage path) keep the
 *  alias surface without re-declaring the literal union. */
export type AggregatorPeriod = Period | "week" | "month";

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
 *  agree on the same boundary for the same period+now. The parameter is
 *  `string` (not `Period`) to mirror `getPeriodStart`, which itself
 *  accepts legacy aliases (`week`/`month`). */
export function periodSinceIso(period: string, now: Date = new Date()): string | null {
  return getPeriodStart(period, now)?.toISOString() ?? null;
}

/** Period → Unix-ms lower bound, or null for "all". Same wider-`string`
 *  signature as `periodSinceIso` for the same reason — both wrap the
 *  same `getPeriodStart` and need to accept legacy aliases. */
export function periodSinceMs(period: string, now: Date = new Date()): number | null {
  return getPeriodStart(period, now)?.getTime() ?? null;
}
