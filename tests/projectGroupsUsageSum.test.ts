import { describe, it, expect } from "vitest";
import { sumUsageReports } from "@/lib/groups/usageSum";
import type { UsageReport } from "@/lib/usage/types";

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    period: "30d",
    totalCost: 10,
    totalTokens: 1000,
    totalSessions: 3,
    totalTurns: 40,
    tokens: { input: 300, output: 100, cacheRead: 500, cacheWrite: 100 },
    cacheHitRate: 500 / 900,
    subagentCost: 2,
    subagentTokens: 200,
    byModel: [
      {
        model: "claude-opus-5",
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheCreateTokens: 100,
        cost: 10,
        turns: 40,
        selfCorrectionRate: 0.1,
        sessionsAsPrimary: 3,
      },
    ],
    byCategory: [
      { category: "Coding", turns: 30, tokens: 800, cost: 8, oneShotRate: 0.5 },
      { category: "Git Ops", turns: 10, tokens: 200, cost: 2 },
    ],
    daily: [{ date: "2026-09-01", cost: 10, inputTokens: 300, outputTokens: 100, turns: 40 }],
    ...over,
  } as UsageReport;
}

describe("sumUsageReports", () => {
  it("reproduces a single report on every emitted field", () => {
    const r = report();
    const s = sumUsageReports([r]);
    expect(s.totalCost).toBe(r.totalCost);
    expect(s.totalTokens).toBe(r.totalTokens);
    expect(s.totalSessions).toBe(r.totalSessions);
    expect(s.totalTurns).toBe(r.totalTurns);
    expect(s.tokens).toEqual(r.tokens);
    expect(s.cacheHitRate).toBeCloseTo(r.cacheHitRate, 12);
    expect(s.subagentCost).toBe(r.subagentCost);
    expect(s.subagentTokens).toBe(r.subagentTokens);
    expect(s.byModel).toEqual([
      {
        model: "claude-opus-5",
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheCreateTokens: 100,
        cost: 10,
        turns: 40,
      },
    ]);
    expect(s.byCategory).toEqual([
      { category: "Coding", turns: 30, tokens: 800, cost: 8 },
      { category: "Git Ops", turns: 10, tokens: 200, cost: 2 },
    ]);
    expect(s.daily).toEqual(r.daily);
  });

  it("does not carry rates that cannot be summed", () => {
    const s = sumUsageReports([report()]);
    expect("selfCorrectionRate" in s.byModel[0]).toBe(false);
    expect("oneShotRate" in s.byCategory[0]).toBe(false);
    expect("oneShot" in s).toBe(false);
  });

  it("doubles every additive field for two identical reports and keeps one row per key", () => {
    const s = sumUsageReports([report(), report()]);
    expect(s.totalCost).toBe(20);
    expect(s.totalTokens).toBe(2000);
    expect(s.totalSessions).toBe(6);
    expect(s.totalTurns).toBe(80);
    expect(s.tokens).toEqual({ input: 600, output: 200, cacheRead: 1000, cacheWrite: 200 });
    expect(s.subagentCost).toBe(4);
    expect(s.byModel).toHaveLength(1);
    expect(s.byModel[0]).toMatchObject({ cost: 20, turns: 80, cacheReadTokens: 1000 });
    expect(s.byCategory).toHaveLength(2);
    expect(s.byCategory[0]).toMatchObject({ category: "Coding", cost: 16, turns: 60 });
    expect(s.daily).toEqual([{ date: "2026-09-01", cost: 20, inputTokens: 600, outputTokens: 200, turns: 80 }]);
  });

  it("recomputes the cache-hit rate from summed tokens, never by averaging", () => {
    // Location A: 900 denominator, 500 read → 0.556. Location B: tiny, 100% hit.
    const a = report();
    const b = report({
      tokens: { input: 0, output: 5, cacheRead: 10, cacheWrite: 0 },
      cacheHitRate: 1,
    });
    const s = sumUsageReports([a, b]);
    // Averaging would give ~0.78; the pooled rate is 510 / 910.
    expect(s.cacheHitRate).toBeCloseTo(510 / 910, 12);
  });

  it("merges distinct keys and orders by cost then date", () => {
    const a = report();
    const b = report({
      byModel: [
        {
          model: "claude-haiku-4-5-20251001",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          cost: 30,
          turns: 1,
        },
      ],
      byCategory: [{ category: "Testing", turns: 1, tokens: 1, cost: 100 }],
      daily: [{ date: "2026-08-31", cost: 1, inputTokens: 1, outputTokens: 1, turns: 1 }],
    });
    const s = sumUsageReports([a, b]);
    expect(s.byModel.map((m) => m.model)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5"]);
    expect(s.byCategory.map((c) => c.category)).toEqual(["Testing", "Coding", "Git Ops"]);
    expect(s.daily.map((d) => d.date)).toEqual(["2026-08-31", "2026-09-01"]);
  });

  it("returns zeros and an undefined rate for no reports", () => {
    const s = sumUsageReports([]);
    expect(s.totalCost).toBe(0);
    expect(s.cacheHitRate).toBeUndefined();
    expect(s.byModel).toEqual([]);
  });
});
