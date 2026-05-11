import { describe, it, expect } from "vitest";
import {
  USAGE_PERIODS,
  isUsagePeriod,
  parseUsagePeriod,
  periodSinceIso,
  periodSinceMs,
} from "@/lib/usage/period";

// Phase 4.1: shared period helpers for /api/agents/[id] and
// /api/skills/[id]. The DB-backed path passes the ISO lower bound to
// SQLite as a TEXT comparison (`tu.ts >= ?`); the file-parse path
// compares Unix ms via Date.parse on `UsageTurn.timestamp`. Both
// helpers therefore have to be consistent — same fixed "now" should
// produce the same window in both representations.

const NOW = new Date("2026-05-11T12:00:00Z");

describe("isUsagePeriod / parseUsagePeriod", () => {
  it("accepts all valid periods", () => {
    for (const p of USAGE_PERIODS) expect(isUsagePeriod(p)).toBe(true);
  });

  it("rejects unknown strings and non-string input", () => {
    expect(isUsagePeriod("month")).toBe(false);
    expect(isUsagePeriod("")).toBe(false);
    expect(isUsagePeriod(null)).toBe(false);
    expect(isUsagePeriod(undefined)).toBe(false);
    expect(isUsagePeriod(7)).toBe(false);
  });

  it("parseUsagePeriod falls back to 'all' for unknown values", () => {
    expect(parseUsagePeriod("garbage")).toBe("all");
    expect(parseUsagePeriod(null)).toBe("all");
    expect(parseUsagePeriod(undefined)).toBe("all");
  });

  it("parseUsagePeriod respects a custom fallback", () => {
    expect(parseUsagePeriod(null, "7d")).toBe("7d");
  });

  it("parseUsagePeriod returns the value when it's a valid period", () => {
    expect(parseUsagePeriod("24h")).toBe("24h");
    expect(parseUsagePeriod("7d")).toBe("7d");
    expect(parseUsagePeriod("30d")).toBe("30d");
  });
});

describe("periodSinceIso", () => {
  it("returns null for 'all'", () => {
    expect(periodSinceIso("all", NOW)).toBeNull();
  });

  it("computes the 24h lower bound", () => {
    expect(periodSinceIso("24h", NOW)).toBe("2026-05-10T12:00:00.000Z");
  });

  it("computes the 7d lower bound", () => {
    expect(periodSinceIso("7d", NOW)).toBe("2026-05-04T12:00:00.000Z");
  });

  it("computes the 30d lower bound", () => {
    expect(periodSinceIso("30d", NOW)).toBe("2026-04-11T12:00:00.000Z");
  });

  it("returns a lexicographically sortable string", () => {
    // ISO8601 sorting is the whole point — a tu.ts row with a later
    // timestamp must compare greater than the returned bound.
    const bound = periodSinceIso("24h", NOW)!;
    const laterIso = "2026-05-11T11:59:00.000Z";
    expect(laterIso > bound).toBe(true);
    const earlierIso = "2026-05-10T11:00:00.000Z";
    expect(earlierIso > bound).toBe(false);
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
