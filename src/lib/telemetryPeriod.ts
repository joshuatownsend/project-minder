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
