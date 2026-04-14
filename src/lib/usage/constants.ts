export const VALID_PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
] as const;

export type Period = (typeof VALID_PERIODS)[number]["value"];

export function validatePeriod(input: string): Period {
  const valid = VALID_PERIODS.map((p) => p.value as string);
  return valid.includes(input) ? (input as Period) : "month";
}
