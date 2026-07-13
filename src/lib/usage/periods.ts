// Shared period-boundary helper. Both the file-parse aggregator
// (`generateUsageReport`) and the SQLite-backed rehydrate path
// (`loadFilteredUsageTurns`) need to compute the inclusive lower bound
// for a `period` filter. Centralizing it here means a future change
// applies to both backends in lockstep.
//
// `now` is injectable so tests can pin the boundary deterministically;
// production callers omit it and get `new Date()`.
//
// Period vocabulary is rolling-window plus calendar-today (24h / today /
// 7d / 30d / 90d / 1y / all), matching the labels users see on the toggle.
// Legacy `week` / `month` / `quarter` / `year` keys still resolve here as
// aliases for `7d` / `30d` / `90d` / `1y` so old URLs keep working;
// validatePeriod() in constants.ts normalizes incoming requests at the API
// boundary.
//
// "24h" is rolling-24h (now − 24h, inclusive). "today" is calendar
// midnight-of-today. They differ at the boundary — a session that ran
// at 11pm yesterday is in "24h" but not in "today" if called after 11pm.
// "90d" and "1y" are rolling windows (now − 90d / now − 365d) used by the
// longer-horizon cost report.

export type Period =
  | "24h"
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "1y"
  | "all"
  | string;

export function getPeriodStart(period: Period, now: Date = new Date()): Date | null {
  switch (period) {
    case "24h":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
    case "90d":
    case "quarter": // alias — rolling 90-day window
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "1y":
    case "year": // alias — rolling 365-day window
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
    default:
      return null;
  }
}
