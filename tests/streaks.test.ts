import { describe, it, expect } from "vitest";
import { computeStreaks } from "@/lib/usage/streaks";
import type { ActivityTurnInput } from "@/lib/usage/activityBuckets";

function ts(dateStr: string): ActivityTurnInput {
  return { timestamp: new Date(dateStr + "T10:00:00").toISOString() };
}

describe("computeStreaks", () => {
  it("returns zeros for empty turn set", () => {
    const result = computeStreaks([]);
    expect(result.currentDays).toBe(0);
    expect(result.longestDays).toBe(0);
    expect(result.lastActiveDate).toBeNull();
    expect(result.totalActiveDays).toBe(0);
  });

  it("handles single-day activity", () => {
    const today = new Date("2026-05-05T12:00:00");
    const result = computeStreaks([ts("2026-05-05")], today);
    expect(result.currentDays).toBe(1);
    expect(result.longestDays).toBe(1);
    expect(result.lastActiveDate).toBe("2026-05-05");
    expect(result.totalActiveDays).toBe(1);
  });

  it("counts a 5-day continuous run when today is last day", () => {
    const today = new Date("2026-05-05T12:00:00");
    const turns = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"].map(ts);
    const result = computeStreaks(turns, today);
    expect(result.currentDays).toBe(5);
    expect(result.longestDays).toBe(5);
  });

  it("continues streak when yesterday was active but today is not", () => {
    const today = new Date("2026-05-05T12:00:00");
    // Active Mon-Sun (yesterday), nothing today
    const turns = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"].map(ts);
    const result = computeStreaks(turns, today);
    // yesterday (May 4) was active → streak still runs back through May 1
    expect(result.currentDays).toBe(4);
  });

  it("returns 0 current streak after a 2-day gap", () => {
    const today = new Date("2026-05-05T12:00:00");
    const turns = ["2026-05-01", "2026-05-02", "2026-05-03"].map(ts);
    const result = computeStreaks(turns, today);
    // Last active May 3, gap of 2 days → current streak is 0
    expect(result.currentDays).toBe(0);
    expect(result.longestDays).toBe(3);
  });

  it("tracks longest streak separately from current", () => {
    const today = new Date("2026-05-10T12:00:00");
    const turns = [
      // Old 5-day run (longest)
      ...["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05"].map(ts),
      // Recent 2-day run (current)
      ...["2026-05-09", "2026-05-10"].map(ts),
    ];
    const result = computeStreaks(turns, today);
    expect(result.longestDays).toBe(5);
    expect(result.currentDays).toBe(2);
  });

  it("de-duplicates multiple turns on the same day", () => {
    const today = new Date("2026-05-05T12:00:00");
    // 3 turns on same day — should count as 1 active day
    const turns = [
      { timestamp: "2026-05-05T09:00:00.000Z" },
      { timestamp: "2026-05-05T11:00:00.000Z" },
      { timestamp: "2026-05-05T15:00:00.000Z" },
    ];
    const result = computeStreaks(turns, today);
    expect(result.totalActiveDays).toBe(1);
    expect(result.currentDays).toBe(1);
  });
});
