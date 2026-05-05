import type { ActivityBucket, StreakStats, ContributionCell } from "./types";

export type ActivityTurnInput = { timestamp: string; cost?: number };

export function toLocalDateStr(ts: string): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface ActivityData {
  byHourOfDay: ActivityBucket[];
  byDayOfWeek: ActivityBucket[];
  byHourDay: ActivityBucket[][];
  streak: StreakStats;
  contributionCalendar: ContributionCell[];
}

function zeroBucket(): ActivityBucket {
  return { turns: 0, tokens: 0, cost: 0 };
}

export function emptyActivity(): ActivityData {
  return {
    byHourOfDay: Array.from({ length: 24 }, zeroBucket),
    byDayOfWeek: Array.from({ length: 7 }, zeroBucket),
    byHourDay: Array.from({ length: 7 }, () => Array.from({ length: 24 }, zeroBucket)),
    streak: { currentDays: 0, longestDays: 0, lastActiveDate: null, totalActiveDays: 0 },
    contributionCalendar: [],
  };
}

export function bucketByHourDay(turns: ActivityTurnInput[]): Pick<ActivityData, "byHourOfDay" | "byDayOfWeek" | "byHourDay"> {
  const byHourOfDay: ActivityBucket[] = Array.from({ length: 24 }, zeroBucket);
  const byDayOfWeek: ActivityBucket[] = Array.from({ length: 7 }, zeroBucket);
  const byHourDay: ActivityBucket[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, zeroBucket)
  );

  for (const t of turns) {
    const d = new Date(t.timestamp);
    const hour = d.getHours();
    const dow = d.getDay();
    const cost = t.cost ?? 0;

    byHourOfDay[hour].turns++;
    byHourOfDay[hour].cost += cost;

    byDayOfWeek[dow].turns++;
    byDayOfWeek[dow].cost += cost;

    byHourDay[dow][hour].turns++;
    byHourDay[dow][hour].cost += cost;
  }

  return { byHourOfDay, byDayOfWeek, byHourDay };
}
