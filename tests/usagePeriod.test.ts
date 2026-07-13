import { describe, it, expect } from "vitest";
import {
  DETAIL_PERIODS,
  parseUsagePeriod,
  periodSinceIso,
  periodSinceMs,
} from "@/lib/usage/period";

// Phase 4.1: thin wrappers over the canonical `validatePeriod` /
// `getPeriodStart` helpers in usage/constants.ts + usage/periods.ts.
// The DB-backed path passes the ISO lower bound to SQLite as a TEXT
// comparison (`tu.ts >= ?`); the file-parse path compares Unix ms via
// Date.parse on `UsageTurn.timestamp`. Both helpers therefore have to
// be consistent — same fixed "now" should produce the same window in
// both representations.

const NOW = new Date("2026-05-11T12:00:00Z");

describe("parseUsagePeriod", () => {
  it("returns the no-param fallback when value is empty", () => {
    expect(parseUsagePeriod(null)).toBe("all");
    expect(parseUsagePeriod(undefined)).toBe("all");
    expect(parseUsagePeriod("")).toBe("all");
  });

  it("respects a custom no-param fallback", () => {
    expect(parseUsagePeriod(null, "7d")).toBe("7d");
  });

  it("returns the value when it's a valid period", () => {
    expect(parseUsagePeriod("24h")).toBe("24h");
    expect(parseUsagePeriod("7d")).toBe("7d");
    expect(parseUsagePeriod("30d")).toBe("30d");
    expect(parseUsagePeriod("today")).toBe("today");
    expect(parseUsagePeriod("all")).toBe("all");
  });

  it("delegates legacy aliases to validatePeriod (week→7d, month→30d)", () => {
    expect(parseUsagePeriod("week")).toBe("7d");
    expect(parseUsagePeriod("month")).toBe("30d");
  });

  it("falls back to validatePeriod's '30d' default on junk input", () => {
    // validatePeriod's invalid-input default is "30d"; we preserve that
    // because the call site already opted in by passing a non-empty
    // string (i.e. someone explicitly asked for a bad period).
    expect(parseUsagePeriod("garbage")).toBe("30d");
  });
});

describe("DETAIL_PERIODS", () => {
  it("excludes 'today' but includes 24h/7d/30d/90d/1y/all in order", () => {
    expect(DETAIL_PERIODS.map((p) => p.value)).toEqual(["24h", "7d", "30d", "90d", "1y", "all"]);
  });
});

describe("parseUsagePeriod — 90d / 1y periods and aliases", () => {
  it("accepts the new 90d and 1y periods", () => {
    expect(parseUsagePeriod("90d")).toBe("90d");
    expect(parseUsagePeriod("1y")).toBe("1y");
  });

  it("resolves aliases quarter→90d and year/365d→1y", () => {
    expect(parseUsagePeriod("quarter")).toBe("90d");
    expect(parseUsagePeriod("year")).toBe("1y");
    expect(parseUsagePeriod("365d")).toBe("1y");
  });
});

describe("periodSinceIso", () => {
  it("returns null for 'all'", () => {
    expect(periodSinceIso("all", NOW)).toBeNull();
  });

  it("computes the 24h rolling lower bound", () => {
    expect(periodSinceIso("24h", NOW)).toBe("2026-05-10T12:00:00.000Z");
  });

  it("computes the 7d lower bound", () => {
    expect(periodSinceIso("7d", NOW)).toBe("2026-05-04T12:00:00.000Z");
  });

  it("computes the 30d lower bound", () => {
    expect(periodSinceIso("30d", NOW)).toBe("2026-04-11T12:00:00.000Z");
  });

  it("computes the 90d rolling lower bound", () => {
    expect(periodSinceIso("90d", NOW)).toBe("2026-02-10T12:00:00.000Z");
  });

  it("computes the 1y (365d) rolling lower bound", () => {
    expect(periodSinceIso("1y", NOW)).toBe("2025-05-11T12:00:00.000Z");
  });

  it("computes calendar-today as local-timezone midnight of NOW", () => {
    // `getPeriodStart("today")` calls `setHours(0,0,0,0)` which is
    // local-timezone start-of-day, not UTC. We assert the wall-clock
    // hour is zero locally rather than pinning a UTC string — the
    // existing `getPeriodStart` semantic is what calendar-cost rollups
    // rely on, so this test reflects what callers receive.
    const result = periodSinceIso("today", NOW)!;
    const localHour = new Date(result).getHours();
    expect(localHour).toBe(0);
  });

  it("returns a lexicographically sortable string", () => {
    // ISO8601 sorting is the whole point — a tu.ts row with a later
    // timestamp must compare greater than the returned bound.
    const bound = periodSinceIso("24h", NOW)!;
    expect("2026-05-11T11:59:00.000Z" > bound).toBe(true);
    expect("2026-05-10T11:00:00.000Z" > bound).toBe(false);
  });
});

describe("periodSinceMs", () => {
  it("returns null for 'all'", () => {
    expect(periodSinceMs("all", NOW)).toBeNull();
  });

  it("computes 24h as ms", () => {
    expect(periodSinceMs("24h", NOW)).toBe(NOW.getTime() - 24 * 60 * 60_000);
  });

  it("stays in sync with periodSinceIso for the same 'now'", () => {
    const ms = periodSinceMs("7d", NOW)!;
    const iso = periodSinceIso("7d", NOW)!;
    expect(new Date(ms).toISOString()).toBe(iso);
  });
});
