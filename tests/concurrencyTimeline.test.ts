import { describe, it, expect } from "vitest";
import { buildConcurrencyTimeline } from "@/lib/usage/concurrencyTimeline";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(overrides: Partial<UsageTurn>): UsageTurn {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "sess1",
    projectSlug: "proj",
    projectDirName: "proj",
    model: "claude-sonnet-4-6",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe("buildConcurrencyTimeline", () => {
  it("returns empty bars for session with no subagents", () => {
    const turns = [
      makeTurn({ role: "user" }),
      makeTurn({ role: "assistant" }),
    ];
    const result = buildConcurrencyTimeline(turns);
    expect(result.bars).toHaveLength(0);
  });

  it("produces main bar + one subagent bar for single sidechain", () => {
    const agentToolUseId = "tool-001";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [{ name: "Agent", id: agentToolUseId, arguments: { subagent_type: "code-reviewer" } }],
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
      makeTurn({
        isSidechain: true,
        parentToolUseId: agentToolUseId,
        timestamp: "2026-01-01T10:01:00.000Z",
      }),
      makeTurn({
        isSidechain: true,
        parentToolUseId: agentToolUseId,
        timestamp: "2026-01-01T10:02:00.000Z",
      }),
    ];

    const result = buildConcurrencyTimeline(turns);
    expect(result.bars.length).toBe(2);

    const mainBar = result.bars.find((b) => b.nodeId === "__main__");
    expect(mainBar).toBeDefined();
    expect(mainBar!.agentName).toBe("main");

    const agentBar = result.bars.find((b) => b.nodeId === agentToolUseId);
    expect(agentBar).toBeDefined();
    expect(agentBar!.agentName).toBe("code-reviewer");
    expect(agentBar!.turnCount).toBe(2);
  });

  it("uses JSONL fallback when timestamps are missing", () => {
    const agentToolUseId = "tool-002";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [{ name: "Agent", id: agentToolUseId, arguments: { subagent_type: "explore" } }],
        timestamp: "",
      }),
      makeTurn({ isSidechain: true, parentToolUseId: agentToolUseId, timestamp: "" }),
    ];

    const result = buildConcurrencyTimeline(turns);
    expect(result.usedFallback).toBe(true);
    expect(result.bars.length).toBeGreaterThan(0);
  });

  it("handles parallel subagents and produces correct bar count", () => {
    const id1 = "tool-p1";
    const id2 = "tool-p2";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [
          { name: "Agent", id: id1, arguments: { subagent_type: "agent-A" } },
          { name: "Agent", id: id2, arguments: { subagent_type: "agent-B" } },
        ],
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
      makeTurn({ isSidechain: true, parentToolUseId: id1, timestamp: "2026-01-01T10:01:00.000Z" }),
      makeTurn({ isSidechain: true, parentToolUseId: id2, timestamp: "2026-01-01T10:01:30.000Z" }),
      makeTurn({ timestamp: "2026-01-01T10:03:00.000Z" }),
    ];

    const result = buildConcurrencyTimeline(turns);
    // main + 2 sidechains
    expect(result.bars.length).toBe(3);
  });

  it("orphan sidechain (no parent in agentByToolUseId) gets generic name", () => {
    const turns = [
      makeTurn({ isSidechain: true, parentToolUseId: "orphan-id", timestamp: "2026-01-01T10:00:00.000Z" }),
    ];
    const result = buildConcurrencyTimeline(turns);
    const orphan = result.bars.find((b) => b.nodeId === "orphan-id");
    expect(orphan).toBeDefined();
    expect(orphan!.agentName).toBe("subagent");
  });

  it("virtual main bar covers full session span", () => {
    const id1 = "tool-m1";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "helper" } }],
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
      makeTurn({ isSidechain: true, parentToolUseId: id1, timestamp: "2026-01-01T10:05:00.000Z" }),
      makeTurn({ timestamp: "2026-01-01T10:10:00.000Z" }),
    ];

    const result = buildConcurrencyTimeline(turns);
    const mainBar = result.bars.find((b) => b.nodeId === "__main__");
    expect(mainBar).toBeDefined();
    expect(mainBar!.startPct).toBeCloseTo(0, 0);
    expect(mainBar!.endPct).toBeCloseTo(100, 0);
  });
});
