// Standard time-slice vocabulary used across every period toggle in the app
// (Home, Stats telemetry cards, Kanban, Usage dashboard). Four options always:
// today / rolling-7d / rolling-30d / all-time. Earlier this file used
// calendar-aligned "this week" / "this month", which collided with the
// rolling labels other surfaces used and made early-month data confusing.
export const VALID_PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
] as const;

export type Period = (typeof VALID_PERIODS)[number]["value"];

// Legacy aliases — prior versions of the API and stored URLs may pass
// `week` or `month`. We normalize them to the rolling-window equivalents
// rather than reject so deep links keep working.
const LEGACY_ALIASES: Record<string, Period> = {
  week: "7d",
  month: "30d",
};

export function validatePeriod(input: string): Period {
  if (LEGACY_ALIASES[input]) return LEGACY_ALIASES[input];
  const valid = VALID_PERIODS.map((p) => p.value as string);
  return valid.includes(input) ? (input as Period) : "30d";
}
