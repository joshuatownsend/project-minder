import { describe, it, expect } from "vitest";
import { computeContributionCalendar } from "@/lib/usage/contributionCalendar";
import { startOfWeek } from "date-fns";
import type { ActivityTurnInput } from "@/lib/usage/activityBuckets";

function ts(dateStr: string): ActivityTurnInput {
  return { timestamp: new Date(dateStr + "T10:00:00").toISOString(), cost: 0.01 };
}

describe("computeContributionCalendar", () => {
  const TODAY = new Date("2026-05-05T12:00:00"); // Tuesday

  it("produces exactly 364 cells (52 weeks × 7 days)", () => {
    const cells = computeContributionCalendar([], TODAY);
    expect(cells).toHaveLength(364);
  });

  it("last cell's date falls on today's day-of-week within today's week", () => {
    const cells = computeContributionCalendar([], TODAY);
    const lastWeekCells = cells.filter((c) => c.weekIndex === 51);
    // Last week should contain today (2026-05-05, Tuesday = dayOfWeek 2)
    const tuesdayCell = lastWeekCells.find((c) => c.dayOfWeek === 2);
    expect(tuesdayCell?.date).toBe("2026-05-05");
  });

  it("first cell is the Sunday 51 weeks before today's week-start", () => {
    const cells = computeContributionCalendar([], TODAY);
    const weekStart = startOfWeek(TODAY, { weekStartsOn: 0 });
    // oldest Sunday = weekStart - 51 weeks
    const oldestMs = weekStart.getTime() - 51 * 7 * 86_400_000;
    const expectedDate = new Date(oldestMs).toISOString().slice(0, 10);
    expect(cells[0].date).toBe(expectedDate);
    expect(cells[0].dayOfWeek).toBe(0); // Sunday
    expect(cells[0].weekIndex).toBe(0);
  });

  it("cells with no turns have turns=0 and cost=0", () => {
    const cells = computeContributionCalendar([ts("2026-05-05")], TODAY);
    const emptyCell = cells.find((c) => c.date === "2026-05-04");
    expect(emptyCell).toBeDefined();
    expect(emptyCell!.turns).toBe(0);
    expect(emptyCell!.cost).toBe(0);
  });

  it("cells with activity carry correct turn counts and cost", () => {
    const turns: ActivityTurnInput[] = [
      { timestamp: "2026-05-05T08:00:00.000Z", cost: 0.01 },
      { timestamp: "2026-05-05T14:00:00.000Z", cost: 0.02 },
    ];
    const cells = computeContributionCalendar(turns, TODAY);
    const cell = cells.find((c) => c.date === "2026-05-05");
    expect(cell).toBeDefined();
    expect(cell!.turns).toBe(2);
    expect(cell!.cost).toBeCloseTo(0.03);
  });

  it("all cells have dayOfWeek matching their date", () => {
    const cells = computeContributionCalendar([], TODAY);
    for (const cell of cells) {
      const actual = new Date(cell.date + "T12:00:00").getDay();
      expect(cell.dayOfWeek).toBe(actual);
    }
  });

  it("weekIndex 0 contains only Sundays (dayOfWeek 0)", () => {
    const cells = computeContributionCalendar([], TODAY);
    const week0 = cells.filter((c) => c.weekIndex === 0);
    expect(week0).toHaveLength(7);
    expect(week0[0].dayOfWeek).toBe(0);
  });
});
