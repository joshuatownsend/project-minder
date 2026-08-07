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
 * `now` is injectable so `periodToSince` can hand in a bucketed clock without
 * duplicating the mapping. Server callers omit it and get the live clock, which
 * is byte-for-byte the behaviour this function has always had.
 */
export function periodToMs(period: Period, now: number = Date.now()): number {
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === "7d") return now - 7 * DAY_MS;
  if (period === "30d") return now - 30 * DAY_MS;
  // "all" — 0 so the SQL `WHERE ts >= ?` matches every row, and so
  // `getHookActivity`'s `since <= 0` all-history check fires.
  return 0;
}

/**
 * Start of the window as an ISO-8601 string, bucketed to the current hour.
 *
 * The bucketing is load-bearing, not cosmetic. These strings go straight into
 * fetch URLs; without it every render of a `7d` or `30d` card mints a fresh
 * millisecond, so the URL changes, so the fetch re-fires, so the component
 * re-renders — the tight refetch loop that `defaultSince` (format.ts) was
 * written to stop, on this same Stats page. `today` and `all` are already
 * stable; only the two rolling windows need it.
 */
export function periodToSince(period: Period): string {
  const nowBucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(periodToMs(period, nowBucket)).toISOString();
}
