import { describe, it, expect } from "vitest";
import type { ProjectDetail } from "@/lib/usage/types";
import type { YieldReport } from "@/lib/usage/yieldAnalysis";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeYieldReport(overrides: Partial<YieldReport> = {}): YieldReport {
  return {
    totalSessions: 10,
    productive: 7,
    reverted: 1,
    abandoned: 2,
    yieldRate: 0.7,
    dollarsPerShippedCommit: null,
    perSession: [],
    ...overrides,
  };
}

function makeProjectDetail(slug: string): ProjectDetail {
  return {
    projectSlug: slug,
    projectDirName: slug,
    cost: 1.5,
    turns: 100,
    categoryBreakdown: [],
    topTools: [],
    mcpServers: [],
    mcpCalls: 0,
  };
}

// ── PortfolioYield aggregation logic (replicated for unit testing) ──────────
// Tests the computation logic that augmentPortfolioYield applies, without
// needing to import the full aggregator (which has server-only imports).

function aggregateYieldReports(
  reports: { detail: ProjectDetail; yr: YieldReport }[]
): { totalSessions: number; productive: number; reverted: number; abandoned: number; yieldRate: number } {
  let totalSessions = 0;
  let productive = 0;
  let reverted = 0;
  let abandoned = 0;

  for (const { yr } of reports) {
    totalSessions += yr.totalSessions;
    productive += yr.productive;
    reverted += yr.reverted;
    abandoned += yr.abandoned;
  }

  return {
    totalSessions,
    productive,
    reverted,
    abandoned,
    yieldRate: totalSessions > 0 ? productive / totalSessions : 0,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("portfolio yield aggregation", () => {
  it("sums sessions across projects", () => {
    const a = makeProjectDetail("a");
    const b = makeProjectDetail("b");
    const yr_a = makeYieldReport({ totalSessions: 10, productive: 7, reverted: 1, abandoned: 2 });
    const yr_b = makeYieldReport({ totalSessions: 5,  productive: 3, reverted: 0, abandoned: 2 });

    const result = aggregateYieldReports([
      { detail: a, yr: yr_a },
      { detail: b, yr: yr_b },
    ]);

    expect(result.totalSessions).toBe(15);
    expect(result.productive).toBe(10);
    expect(result.reverted).toBe(1);
    expect(result.abandoned).toBe(4);
    expect(result.yieldRate).toBeCloseTo(10 / 15);
  });

  it("yieldRate is 0 when totalSessions is 0", () => {
    const result = aggregateYieldReports([]);
    expect(result.yieldRate).toBe(0);
    expect(result.totalSessions).toBe(0);
  });

  it("100% yield rate when all sessions are productive", () => {
    const yr = makeYieldReport({ totalSessions: 20, productive: 20, reverted: 0, abandoned: 0, yieldRate: 1 });
    const result = aggregateYieldReports([{ detail: makeProjectDetail("x"), yr }]);
    expect(result.yieldRate).toBeCloseTo(1);
  });

  it("handles single project with zero sessions", () => {
    const yr = makeYieldReport({ totalSessions: 0, productive: 0, reverted: 0, abandoned: 0, yieldRate: 0 });
    const result = aggregateYieldReports([{ detail: makeProjectDetail("x"), yr }]);
    expect(result.totalSessions).toBe(0);
    expect(result.yieldRate).toBe(0);
  });

  it("attaches yield to project detail", () => {
    const pd = makeProjectDetail("proj");
    const yr = makeYieldReport();
    pd.yield = yr;
    expect(pd.yield).toBeDefined();
    expect(pd.yield!.yieldRate).toBe(0.7);
  });

  it("yieldRate is proportionally weighted by session count", () => {
    // Project A: 100 sessions, 50% yield
    // Project B: 10 sessions, 90% yield
    // Naive average would be 70%; weighted (by session count) should be ~54.5%
    const yr_a = makeYieldReport({ totalSessions: 100, productive: 50, reverted: 10, abandoned: 40, yieldRate: 0.5 });
    const yr_b = makeYieldReport({ totalSessions: 10,  productive: 9,  reverted: 0,  abandoned: 1,  yieldRate: 0.9 });
    const result = aggregateYieldReports([
      { detail: makeProjectDetail("a"), yr: yr_a },
      { detail: makeProjectDetail("b"), yr: yr_b },
    ]);
    // 59 productive / 110 total = 53.6%
    expect(result.yieldRate).toBeCloseTo(59 / 110);
  });
});
