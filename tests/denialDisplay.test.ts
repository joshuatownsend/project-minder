import { describe, it, expect } from "vitest";
import {
  describeDenialRate,
  anyDenialOutcomeMeasured,
} from "@/lib/telemetry/denialDisplay";

describe("describeDenialRate", () => {
  // The case the whole module exists for. On the reference index all four
  // denial kinds come back with `verifiedTasks: undefined` — task outcomes
  // cover well under 1% of turns and never coincided with a denial. Rendering
  // "—" four times reads as a pending measurement.
  it("returns null when no denied turn recorded an outcome", () => {
    expect(describeDenialRate({})).toBeNull();
    expect(describeDenialRate({ verifiedTasks: undefined, oneShotTasks: undefined })).toBeNull();
  });

  // The distinction that matters most: a measured zero is a finding, not a gap.
  // A kind where every denied turn's task went on to need a retry is exactly
  // the signal this cross exists to surface, and it must not be swallowed by
  // the same branch that handles "no data".
  it("reports a real zero as 0%, not as absence", () => {
    const r = describeDenialRate({ verifiedTasks: 5, oneShotTasks: 0 });
    expect(r).not.toBeNull();
    expect(r!.text).toBe("0% 1st-pass");
    expect(r!.rate).toBe(0);
    expect(r!.sample).toBe(5);
  });

  it("computes and rounds the rate", () => {
    expect(describeDenialRate({ verifiedTasks: 3, oneShotTasks: 2 })!.text).toBe("67% 1st-pass");
    expect(describeDenialRate({ verifiedTasks: 4, oneShotTasks: 4 })!.text).toBe("100% 1st-pass");
    expect(describeDenialRate({ verifiedTasks: 8, oneShotTasks: 1 })!.text).toBe("13% 1st-pass");
  });

  it("names both counts in the hover text so the percentage is auditable", () => {
    const r = describeDenialRate({ verifiedTasks: 12, oneShotTasks: 9 })!;
    expect(r.title).toContain("9 of 12");
    expect(r.title).toContain("tasks");
  });

  it("uses the singular for a sample of one", () => {
    expect(describeDenialRate({ verifiedTasks: 1, oneShotTasks: 1 })!.title).toContain("1 of 1 task ");
  });

  // Guarded by invariant, not by observation: SQL `GROUP BY` cannot emit a
  // group with `COUNT(*) = 0`, but that invariant lives in another file and a
  // future caller need not honour it. Dividing by zero would render "NaN%".
  it("refuses a zero denominator rather than dividing by it", () => {
    expect(describeDenialRate({ verifiedTasks: 0, oneShotTasks: 0 })).toBeNull();
  });

  it("refuses a denominator with no numerator instead of calling it 0%", () => {
    // Missing data reported as the most alarming available reading is how a
    // gap turns into a false alarm.
    expect(describeDenialRate({ verifiedTasks: 7 })).toBeNull();
  });
});

describe("anyDenialOutcomeMeasured", () => {
  it("is false when every kind is unmeasured", () => {
    expect(
      anyDenialOutcomeMeasured([{}, { verifiedTasks: undefined }, { oneShotTasks: undefined }]),
    ).toBe(false);
  });

  it("is false for no rows at all", () => {
    expect(anyDenialOutcomeMeasured([])).toBe(false);
  });

  it("is true as soon as one kind has a usable sample", () => {
    expect(anyDenialOutcomeMeasured([{}, { verifiedTasks: 2, oneShotTasks: 0 }])).toBe(true);
  });

  // Agrees with describeDenialRate by construction rather than by a second
  // copy of the rules — a row the renderer would reject must not be counted
  // here as a reason to show the column.
  it("does not count a row describeDenialRate would reject", () => {
    expect(anyDenialOutcomeMeasured([{ verifiedTasks: 4 }, { verifiedTasks: 0, oneShotTasks: 0 }])).toBe(false);
  });
});
