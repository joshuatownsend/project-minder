import { describe, it, expect } from "vitest";
import { bucketByHourDay, emptyActivity } from "@/lib/usage/activityBuckets";

function turn(hour: number, dow: number, cost = 0.01) {
  // Build a UTC timestamp that resolves to a specific local hour + day-of-week.
  // Use a fixed base date (2026-05-03 = Sunday) + offset days + hours.
  // Tests run in local TZ; use Date constructor with local date parts to guarantee local time.
  const base = new Date(2026, 4, 3 + dow, hour, 0, 0); // May 3 2026 is a Sunday
  return { timestamp: base.toISOString(), cost };
}

describe("bucketByHourDay", () => {
  it("returns 24-length byHourOfDay and 7-length byDayOfWeek", () => {
    const { byHourOfDay, byDayOfWeek } = bucketByHourDay([]);
    expect(byHourOfDay).toHaveLength(24);
    expect(byDayOfWeek).toHaveLength(7);
  });

  it("returns [7][24] byHourDay matrix", () => {
    const { byHourDay } = bucketByHourDay([]);
    expect(byHourDay).toHaveLength(7);
    for (const row of byHourDay) {
      expect(row).toHaveLength(24);
    }
  });

  it("buckets a turn at Sun 14:00 into correct cells", () => {
    const turns = [turn(14, 0)]; // Sunday, 14:00
    const { byHourOfDay, byDayOfWeek, byHourDay } = bucketByHourDay(turns);
    expect(byHourOfDay[14].turns).toBe(1);
    expect(byDayOfWeek[0].turns).toBe(1); // Sunday
    expect(byHourDay[0][14].turns).toBe(1);
  });

  it("turn counts in byHourDay sum to byHourOfDay totals", () => {
    const turns = [turn(9, 1), turn(9, 3), turn(14, 1)];
    const { byHourOfDay, byHourDay } = bucketByHourDay(turns);
    for (let h = 0; h < 24; h++) {
      const matrixSum = byHourDay.reduce((s, row) => s + row[h].turns, 0);
      expect(matrixSum).toBe(byHourOfDay[h].turns);
    }
  });

  it("turn counts in byHourDay sum to byDayOfWeek totals", () => {
    const turns = [turn(9, 1), turn(9, 3), turn(14, 1)];
    const { byDayOfWeek, byHourDay } = bucketByHourDay(turns);
    for (let d = 0; d < 7; d++) {
      const matrixSum = byHourDay[d].reduce((s, b) => s + b.turns, 0);
      expect(matrixSum).toBe(byDayOfWeek[d].turns);
    }
  });

  it("cost totals match across all buckets", () => {
    const turns = [turn(9, 1, 0.05), turn(14, 3, 0.10)];
    const totalExpected = 0.15;
    const { byHourOfDay } = bucketByHourDay(turns);
    const totalActual = byHourOfDay.reduce((s, b) => s + b.cost, 0);
    expect(totalActual).toBeCloseTo(totalExpected);
  });

  it("dayOfWeek 0 = Sunday", () => {
    const turns = [turn(10, 0)]; // Sunday
    const { byDayOfWeek } = bucketByHourDay(turns);
    expect(byDayOfWeek[0].turns).toBe(1);
    for (let d = 1; d < 7; d++) expect(byDayOfWeek[d].turns).toBe(0);
  });

  it("dayOfWeek 6 = Saturday", () => {
    const turns = [turn(10, 6)]; // Saturday
    const { byDayOfWeek } = bucketByHourDay(turns);
    expect(byDayOfWeek[6].turns).toBe(1);
  });
});

describe("emptyActivity", () => {
  it("produces correct shape with all-zero buckets", () => {
    const a = emptyActivity();
    expect(a.byHourOfDay).toHaveLength(24);
    expect(a.byDayOfWeek).toHaveLength(7);
    expect(a.byHourDay).toHaveLength(7);
    expect(a.streak.currentDays).toBe(0);
    expect(a.contributionCalendar).toHaveLength(0);
    for (const b of a.byHourOfDay) {
      expect(b.turns).toBe(0);
      expect(b.cost).toBe(0);
    }
  });
});
