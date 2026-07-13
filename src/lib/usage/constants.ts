// Standard time-slice vocabulary used across every period toggle in the app
// (Home, Stats telemetry cards, Kanban, Usage dashboard, agent/skill detail,
// cost report). Seven options: rolling-24h / calendar-today / rolling-7d /
// rolling-30d / rolling-90d / rolling-1y / all-time. Individual toggles render
// a subset (e.g. the stats cards skip "24h"; the agent/skill detail page skips
// "today"; the cost report skips "24h"). Earlier this file used calendar-aligned
// "this week" / "this month", which collided with the rolling labels other
// surfaces used and made early-month data confusing.
//
// `24h` is the rolling 24-hour window (now − 24h, inclusive). `today` is
// midnight-of-today calendar start. Both are useful — agent/skill detail
// uses 24h because users land there asking "did I invoke this in the last
// day?", while the home/stats cards use today because the day boundary
// aligns with the daily-cost rollup tables. `90d` and `1y` are rolling
// windows (now − 90d / now − 365d) added for the longer-horizon cost report.
export const VALID_PERIODS = [
  { value: "24h", label: "24 hours" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "all", label: "All time" },
] as const;

export type Period = (typeof VALID_PERIODS)[number]["value"];

// The cost report and per-project Costs tab offer six of the seven periods —
// they drop the rolling "24h" window (too granular for a cost-comparison view)
// and keep calendar-today plus the four rolling windows and all-time:
// today / 7d / 30d / 90d / 1y / all.
export const COST_PERIODS = VALID_PERIODS.filter((p) => p.value !== "24h");

// Legacy aliases — prior versions of the API and stored URLs may pass
// `week` or `month`. We normalize them to the rolling-window equivalents
// rather than reject so deep links keep working.
//
// Use a Map (not a plain object) for the lookup so untrusted query input
// like ?period=__proto__ or ?period=toString can't return inherited keys
// and bypass validation (PR #103 codex P2).
const LEGACY_ALIASES = new Map<string, Period>([
  ["week", "7d"],
  ["month", "30d"],
  ["quarter", "90d"],
  ["year", "1y"],
  ["365d", "1y"],
]);

export function validatePeriod(input: string): Period {
  const aliased = LEGACY_ALIASES.get(input);
  if (aliased) return aliased;
  const valid = VALID_PERIODS.map((p) => p.value as string);
  return valid.includes(input) ? (input as Period) : "30d";
}
