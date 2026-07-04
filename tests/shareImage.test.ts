import { describe, it, expect } from "vitest";
import { composeShareSvg } from "@/lib/shareImage";
import type { UsageReport } from "@/lib/usage/types";

function makeReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    period: "month",
    totalCost: 12.34,
    totalTokens: 1_500_000,
    totalSessions: 42,
    totalTurns: 380,
    tokens: { input: 1_000_000, output: 300_000, cacheRead: 150_000, cacheWrite: 50_000 },
    cacheHitRate: 0.65,
    oneShot: { rate: 0.75, totalVerifiedTasks: 20, oneShotTasks: 15 },
    daily: [],
    byModel: [
      { model: "claude-opus-4-7-20250514", inputTokens: 600_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 8.0, turns: 200 },
      { model: "claude-sonnet-4-6-20250514", inputTokens: 500_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 4.34, turns: 180 },
    ],
    byProject: [
      { projectSlug: "proj-a", projectDirName: "project-alpha", tokens: 600_000, cost: 6.0, turns: 100 },
      { projectSlug: "proj-b", projectDirName: "project-beta", tokens: 500_000, cost: 4.5, turns: 80 },
      { projectSlug: "proj-c", projectDirName: "project-gamma", tokens: 400_000, cost: 1.84, turns: 60 },
    ],
    byCategory: [],
    topTools: [],
    toolTransitions: [],
    toolSelfLoops: [],
    shellStats: [],
    mcpStats: [],
    projectDetails: [],
    generatedAt: "2026-05-09T12:00:00Z",
    byHourOfDay: Array.from({ length: 24 }, (_, h) => ({ turns: h * 2, cost: h * 0.1 })),
    byDayOfWeek: [],
    byHourDay: [],
    streak: { currentDays: 7, longestDays: 21, lastActiveDate: "2026-05-09", totalActiveDays: 42 },
    contributionCalendar: [],
    bySource: [],
    subagentCost: 0,
    subagentTokens: 0,
    ...overrides,
  };
}

describe("composeShareSvg", () => {
  it("returns a string starting with <svg", () => {
    const result = composeShareSvg(makeReport());
    expect(result.trimStart()).toMatch(/^<svg/);
  });

  it("contains all four KPI labels", () => {
    const result = composeShareSvg(makeReport());
    expect(result).toContain("Sessions");
    expect(result).toContain("Cost");
    expect(result).toContain("Tokens");
    expect(result).toContain("Streak");
  });

  it("uses default width 1200", () => {
    const result = composeShareSvg(makeReport());
    expect(result).toContain('width="1200"');
  });

  it("honours custom width", () => {
    const result = composeShareSvg(makeReport(), { width: 800 });
    expect(result).toContain('width="800"');
    // The root <svg> element should say width="800", not width="1200"
    const svgTag = result.match(/<svg[^>]*>/)?.[0] ?? "";
    expect(svgTag).toContain('width="800"');
    expect(svgTag).not.toContain('width="1200"');
  });

  it("dark theme does not use near-white surface fill (#ffffff)", () => {
    const result = composeShareSvg(makeReport(), { theme: "dark" });
    expect(result).not.toContain("#ffffff");
  });

  it("light theme uses #ffffff as surface fill", () => {
    const result = composeShareSvg(makeReport(), { theme: "light" });
    expect(result).toContain("#ffffff");
  });

  it("renders top project names", () => {
    const result = composeShareSvg(makeReport());
    expect(result).toContain("project-alpha");
    expect(result).toContain("project-beta");
  });

  it("renders 24 hour bars", () => {
    const result = composeShareSvg(makeReport());
    // Each bar is a <rect> for the hour strip; there should be 24
    const matches = result.match(/<rect/g);
    expect(matches).not.toBeNull();
    // At minimum: bg + 4 KPI cards + 24 hour bars + project bars + model segments
    expect(matches!.length).toBeGreaterThanOrEqual(29);
  });

  it("escapes SVG-unsafe characters in project names", () => {
    const result = composeShareSvg(
      makeReport({
        byProject: [{ projectSlug: "x", projectDirName: "foo & <bar>", tokens: 1, cost: 1, turns: 1 }],
      }),
    );
    expect(result).not.toContain("foo & <bar>");
    expect(result).toContain("foo &amp; &lt;bar&gt;");
  });
});
