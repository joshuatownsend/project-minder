/**
 * The telemetry period vocabulary, in a module a **client** component can
 * import at runtime.
 *
 * `Period` and `periodToMs` used to live only in `db/otelQueries.ts`, which
 * starts with `import "server-only"`. Client components could import the
 * *type* from there safely — a type-only import is erased before bundling —
 * but importing `periodToMs`, a value, would pull `server-only` (and
 * `better-sqlite3` behind it) into the browser bundle and fail the Turbopack
 * build with `Module not found: Can't resolve 'fs'`. That is the same
 * client/server boundary break CLAUDE.md records from PR #324, and neither
 * typecheck nor the test suite can see it.
 *
 * `otelQueries.ts` re-exports both names, so every existing server-side
 * importer keeps working unchanged.
 *
 * Note this is the **four**-value telemetry period, deliberately distinct from
 * the seven-value `Period` in `usage/constants.ts` (which adds 24h/90d/1y for
 * the cost surfaces). They share a name and not much else; the telemetry cards
 * and `PeriodToggle` mean this one.
 */

export type Period = "today" | "7d" | "30d" | "all";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Start of the window, as epoch ms.
 *
 * **The rolling windows resolve from an hour-bucketed clock, and every caller
 * gets the same bucketing.** That is what makes one period name mean one
 * cutoff no matter which path resolves it, and it is load-bearing twice over:
 *
 * 1. *Agreement across cards.* The Telemetry section drives six cards through
 *    two encodings — four take a `since` computed here on the client, two send
 *    the period name and let the route call this server-side. Bucketing only
 *    the client half made those two groups cover windows up to an hour apart
 *    under a single toggle, which is precisely the "cards disagree by
 *    construction" defect the toggle was added to fix (Codex review of #402).
 * 2. *No refetch loop.* `periodToSince` feeds fetch URLs directly. An
 *    unbucketed clock mints a fresh millisecond per render, so the URL
 *    changes, so the fetch re-fires — the loop `defaultSince` (format.ts) was
 *    written to stop, on this same Stats page.
 *
 * `today` (local midnight) and `all` (epoch 0) are already stable; only `7d`
 * and `30d` need it. `now` stays injectable for tests; bucketing is applied
 * inside regardless of who supplies the clock, so the invariant cannot be
 * bypassed by passing a raw timestamp.
 */
export function periodToMs(period: Period, now: number = Date.now()): number {
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // "all" — 0 so the SQL `WHERE ts >= ?` matches every row, and so
  // `getHookActivity`'s `since <= 0` all-history check fires.
  if (period === "all") return 0;

  const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  return bucket - (period === "7d" ? 7 : 30) * DAY_MS;
}

/**
 * Start of the window as an ISO-8601 string — the same instant `periodToMs`
 * returns, for callers whose endpoint takes an explicit lower bound rather
 * than a period name. The two must never disagree; a test pins that.
 */
export function periodToSince(period: Period): string {
  return new Date(periodToMs(period)).toISOString();
}

/**
 * Milliseconds until the next hour boundary — when `periodToSince` will next
 * return a different string.
 *
 * Exists because bucketing alone does not refresh anything. `periodToSince` is
 * evaluated during render, and React does not re-render on wall-clock time, so
 * a Stats page left mounted across a boundary kept its old URLs and its old
 * data indefinitely while the code claimed the cutoff advanced hourly (Codex
 * review of #402). `useTelemetrySince` schedules on this.
 *
 * Never returns 0: exactly on a boundary the next one is a full hour away, and
 * a 0 here would spin a self-rescheduling timer.
 */
export function msUntilNextHourBoundary(now: number = Date.now()): number {
  return HOUR_MS - (now % HOUR_MS);
}

/**
 * Milliseconds until the start of the next local day.
 *
 * `setHours(24, …)` rather than arithmetic on the date, so the browser's own
 * calendar decides — a DST transition makes the day 23 or 25 hours long and
 * `+ 86_400_000` would land an hour off on those two days a year.
 *
 * Never returns 0: called exactly at midnight, the *next* midnight is a day
 * away.
 */
export function msUntilNextLocalMidnight(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime() - now;
}

/**
 * When the cutoff for `period` next changes, or `null` if it never does.
 *
 * The two rolling windows move on the epoch hour, but `today` moves at *local
 * midnight*, and the two are not the same instant in a fractional-offset zone
 * — Asia/Kolkata (+5:30), Asia/Kathmandu (+5:45), America/St_Johns (−3:30).
 * Scheduling `today` on the hour left a page open across midnight showing the
 * previous day's window for up to 45 minutes there (Codex review of #402).
 *
 * The mismatch is not only fractional-zone, which is what makes it worth
 * routing per period rather than taking the minimum of both: an hourly fire at
 * 22:00 recomputes the same midnight and changes nothing, so before this the
 * `today` refresh landed only when a fire happened to coincide with midnight.
 *
 * `all` is epoch 0 forever — `null` says "do not arm a timer" rather than
 * inventing a wake-up that cannot change anything.
 */
export function msUntilCutoffChange(period: Period, now: number = Date.now()): number | null {
  if (period === "all") return null;
  if (period === "today") return msUntilNextLocalMidnight(now);
  return msUntilNextHourBoundary(now);
}

export const PERIODS: readonly Period[] = ["today", "7d", "30d", "all"];

/**
 * Resolve a telemetry window from query params, preferring an explicit `since`.
 *
 * Shared by the routes that accept both spellings rather than copied into each,
 * because two copies of a cutoff rule is how this PR produced two review
 * findings in a row.
 *
 * Returns `{ since }` or `{ error }` — the caller turns the latter into a 400.
 */
export function resolveSinceParam(
  params: URLSearchParams
): { since: number; error?: undefined } | { since?: undefined; error: string } {
  const sinceParam = params.get("since");
  if (sinceParam !== null) {
    const since = new Date(sinceParam).getTime();
    return Number.isFinite(since) ? { since } : { error: "Invalid since parameter" };
  }
  const period = (params.get("period") ?? "7d") as Period;
  return PERIODS.includes(period)
    ? { since: periodToMs(period) }
    : { error: "period must be today|7d|30d|all" };
}
