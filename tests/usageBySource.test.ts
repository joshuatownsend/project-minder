import { describe, it, expect } from "vitest";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity } from "@/lib/usage/activityBuckets";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    sessionId: "sess1",
    projectSlug: "project-a",
    projectDirName: "C--project-a",
    model: "claude-opus-4-7",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

describe("aggregateUsage bySource", () => {
  it("produces one bySource entry for claude-only turns", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1" }),
      makeTurn({ sessionId: "s1", role: "user", model: "<synthetic>", inputTokens: 0, outputTokens: 0 }),
      makeTurn({ sessionId: "s2" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.bySource).toHaveLength(1);
    expect(report.bySource[0].source).toBe("claude");
    expect(report.bySource[0].displayName).toBe("Claude Code");
    expect(report.bySource[0].sessionCount).toBe(2);
  });

  it("produces multiple bySource entries for mixed sources", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", source: "claude" }),
      makeTurn({ sessionId: "s2", source: "codex" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.bySource).toHaveLength(2);
    const sources = report.bySource.map((s) => s.source);
    expect(sources).toContain("claude");
    expect(sources).toContain("codex");
  });

  it("bySource totals match overall totals for single-source", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", inputTokens: 200, outputTokens: 100 }),
      makeTurn({ sessionId: "s1", inputTokens: 50, outputTokens: 25 }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    const claudeSource = report.bySource.find((s) => s.source === "claude");
    expect(claudeSource).toBeDefined();
    expect(claudeSource!.tokens).toBe(report.totalTokens);
  });

  it("coerces missing source to 'claude'", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ source: undefined }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.bySource[0].source).toBe("claude");
  });
});
