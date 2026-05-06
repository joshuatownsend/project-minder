import { describe, it, expect } from "vitest";
import { projectScatter, prepareScatterData } from "@/lib/usage/sessionScatter";
import type { SessionSummary } from "@/lib/types";
import type { SessionScatterPoint } from "@/lib/usage/sessionScatter";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "abc123",
    projectPath: "/dev/test",
    projectSlug: "test",
    projectName: "Test",
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheCreateTokens: 100,
    costEstimate: 0.05,
    toolUsage: { Read: 3, Edit: 2 },
    modelsUsed: ["claude-sonnet-4-5"],
    subagentCount: 0,
    errorCount: 0,
    isActive: false,
    status: "idle",
    skillsUsed: {},
    durationMs: 60000,
    oneShotRate: 0.75,
    maxContextFill: 0.3,
    hasCompactionLoop: false,
    hasToolFailureStreak: false,
    ...overrides,
  } as SessionSummary;
}

describe("projectScatter", () => {
  it("returns a stable shape from a session summary", () => {
    const point = projectScatter(makeSession());
    expect(point).toMatchObject({
      sessionId: "abc123",
      durationMs: 60000,
      costEstimate: 0.05,
      messageCount: 10,
      toolCount: 5,
      oneShotRate: 0.75,
      maxContextFill: 0.3,
      hasCompactionLoop: false,
      hasToolFailureStreak: false,
      status: "idle",
    });
  });

  it("sums toolUsage values into toolCount", () => {
    const point = projectScatter(makeSession({ toolUsage: { Read: 10, Bash: 5, Edit: 3 } }));
    expect(point.toolCount).toBe(18);
  });

  it("handles undefined optional fields with safe defaults", () => {
    const point = projectScatter(makeSession({ durationMs: undefined, oneShotRate: undefined, maxContextFill: undefined }));
    expect(point.durationMs).toBe(0);
    expect(point.oneShotRate).toBe(0);
    expect(point.maxContextFill).toBe(0);
  });
});

describe("prepareScatterData", () => {
  const points: SessionScatterPoint[] = [
    {
      sessionId: "abc123",
      durationMs: 60000,
      costEstimate: 0.05,
      messageCount: 10,
      toolCount: 5,
      oneShotRate: 0.75,
      maxContextFill: 0.3,
      hasCompactionLoop: false,
      hasToolFailureStreak: false,
      status: "idle",
    },
    {
      sessionId: "def456",
      durationMs: 0,
      costEstimate: 0,
      messageCount: 0,
      toolCount: 0,
      oneShotRate: 0,
      maxContextFill: 0,
      hasCompactionLoop: true,
      hasToolFailureStreak: true,
      status: "working",
    },
  ];

  it("returns matched-length arrays for complexity-cost", () => {
    const d = prepareScatterData(points, "complexity-cost");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("returns matched-length arrays for context-pressure", () => {
    const d = prepareScatterData(points, "context-pressure");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("returns matched-length arrays for reliability", () => {
    const d = prepareScatterData(points, "reliability");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("is log-scale safe on zeros (complexity-cost)", () => {
    const zeroPoints = points.map((p) => ({ ...p, durationMs: 0 }));
    const d = prepareScatterData(zeroPoints, "complexity-cost");
    for (const v of d.x) {
      expect(isFinite(v)).toBe(true);
      expect(isNaN(v)).toBe(false);
    }
  });

  it("is log-scale safe on zero costEstimate (context-pressure)", () => {
    const d = prepareScatterData(points, "context-pressure");
    for (const v of d.size) {
      expect(isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(4);
    }
  });

  it("colors compactionLoop sessions differently in context-pressure", () => {
    const d = prepareScatterData(points, "context-pressure");
    // points[1] has hasCompactionLoop: true
    expect(d.color[1]).toContain("error");
    expect(d.color[0]).toContain("info");
  });

  it("colors toolFailureStreak sessions differently in reliability", () => {
    const d = prepareScatterData(points, "reliability");
    // points[1] has hasToolFailureStreak: true
    expect(d.color[1]).toContain("error");
    expect(d.color[0]).not.toContain("error");
  });

  it("handles empty points array without error", () => {
    const d = prepareScatterData([], "complexity-cost");
    expect(d.x).toHaveLength(0);
  });
});
