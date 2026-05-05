import type { StreakStats } from "./types";
import { type ActivityTurnInput, toLocalDateStr } from "./activityBuckets";

export function computeStreaks(turns: ActivityTurnInput[], today?: Date): StreakStats {
  if (turns.length === 0) {
    return { currentDays: 0, longestDays: 0, lastActiveDate: null, totalActiveDays: 0 };
  }

  const activeDates = new Set<string>();
  for (const t of turns) {
    activeDates.add(toLocalDateStr(t.timestamp));
  }

  const sorted = Array.from(activeDates).sort();
  const lastActiveDate = sorted[sorted.length - 1];
  const totalActiveDays = sorted.length;

  // Compute longest streak by scanning sorted unique dates
  let longestDays = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]);
    const curr = new Date(sorted[i]);
    // Check if consecutive calendar days
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / 86_400_000);
    if (diffDays === 1) {
      run++;
      if (run > longestDays) longestDays = run;
    } else {
      run = 1;
    }
  }

  // Compute current streak: count backward from today/yesterday
  const now = today ?? new Date();
  const todayStr = toLocalDateStr(now.toISOString());
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = toLocalDateStr(yesterdayDate.toISOString());

  let currentDays = 0;
  if (activeDates.has(todayStr) || activeDates.has(yesterdayStr)) {
    const anchor = activeDates.has(todayStr) ? todayStr : yesterdayStr;
    // Parse as local noon to avoid UTC-midnight crossing local-date boundaries
    // in negative-offset timezones (e.g. new Date("2026-05-05") = UTC midnight
    // = May 4 local in UTC-5 — so always use "T12:00:00" here).
    const [ay, am, ad] = anchor.split("-").map(Number);
    let cursor = new Date(ay, am - 1, ad, 12, 0, 0);
    while (true) {
      const cursorStr = toLocalDateStr(cursor.toISOString());
      if (!activeDates.has(cursorStr)) break;
      currentDays++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  return { currentDays, longestDays, lastActiveDate, totalActiveDays };
}
