// Shared period-boundary helper. Both the file-parse aggregator
// (`generateUsageReport`) and the SQLite-backed rehydrate path
// (`loadFilteredUsageTurns`) need to compute the inclusive lower bound
// for a `period` filter. Centralizing it here means a future change
// applies to both backends in lockstep.
//
// `now` is injectable so tests can pin the boundary deterministically;
// production callers omit it and get `new Date()`.
//
// Period vocabulary is rolling-window (today / 7d / 30d / all), matching
// the labels users see on the toggle. Legacy `week` / `month` keys still
// resolve here as aliases for `7d` / `30d` so old URLs keep working;
// validatePeriod() in constants.ts normalizes incoming requests at the
// API boundary.

export type Period = "today" | "7d" | "30d" | "all" | string;

export function getPeriodStart(period: Period, now: Date = new Date()): Date | null {
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "7d":
    case "week": // legacy alias — was Sunday-start calendar week
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
    case "month": // legacy alias — was 1st-of-month calendar
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
    default:
      return null;
  }
}
