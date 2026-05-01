// Shared period-boundary helper. Both the file-parse aggregator
// (`generateUsageReport`) and the SQLite-backed rehydrate path
// (`loadFilteredUsageTurns`) need to compute the inclusive lower bound
// for a `period` filter. Centralizing it here means a future change —
// e.g. switching "week" from Sunday-start to Monday-start — applies to
// both backends in lockstep.
//
// `now` is injectable so tests can pin the boundary deterministically;
// production callers omit it and get `new Date()`.

export type Period = "today" | "week" | "month" | "all" | string;

export function getPeriodStart(period: Period, now: Date = new Date()): Date | null {
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "all":
      return null;
    default:
      return null;
  }
}
