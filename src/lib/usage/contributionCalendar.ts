// Deep subpath imports, not the `date-fns` barrel. The barrel re-exports the
// package's ~700 modules, and importing it costs ~2.2s in a vitest fork — two
// thirds of the cold load of the `@/lib/data` graph, which reaches here through
// `usage/aggregator`. Next's `optimizePackageImports` (next.config.ts) rewrites
// the barrel for the app build, so production never paid this; the test module
// runner has no equivalent, so every fork that touched the façade did. That
// cost was being read as "DB fixture setup is slow" (#345, #362) — the SQLite
// driver itself loads in 21ms.
//
// Client components may keep the barrel form: they are covered by
// `optimizePackageImports` and are not in the test graph.
import { startOfWeek } from "date-fns/startOfWeek";
import { subWeeks } from "date-fns/subWeeks";
import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import type { ContributionCell } from "./types";
import { type ActivityTurnInput, toLocalDateStr } from "./activityBuckets";

export function computeContributionCalendar(
  turns: ActivityTurnInput[],
  today?: Date,
  weeks = 52
): ContributionCell[] {
  // Build a map of date -> { turns, cost }
  const dayMap = new Map<string, { turns: number; cost: number }>();
  for (const t of turns) {
    const key = toLocalDateStr(t.timestamp);
    const entry = dayMap.get(key) ?? { turns: 0, cost: 0 };
    entry.turns++;
    entry.cost += t.cost ?? 0;
    dayMap.set(key, entry);
  }

  // Find the Sunday that is the start of the week containing today
  const anchor = today ?? new Date();
  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 });

  // Go back (weeks - 1) more to get the oldest Sunday
  const oldestSunday = subWeeks(weekStart, weeks - 1);

  const cells: ContributionCell[] = [];
  for (let w = 0; w < weeks; w++) {
    const sundayOfWeek = addDays(oldestSunday, w * 7);
    for (let d = 0; d < 7; d++) {
      const cellDate = addDays(sundayOfWeek, d);
      const dateStr = format(cellDate, "yyyy-MM-dd");
      const data = dayMap.get(dateStr) ?? { turns: 0, cost: 0 };
      cells.push({
        date: dateStr,
        turns: data.turns,
        cost: data.cost,
        weekIndex: w,
        dayOfWeek: d,
      });
    }
  }

  return cells;
}
