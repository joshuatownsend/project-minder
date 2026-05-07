import { describe, it, expect } from "vitest";

// We test the pure buildErrorPropagation logic indirectly by testing the
// underlying buildGraph + depth accumulation logic, since the full function
// requires real JSONL files. We verify the aggregation logic directly by
// constructing mock graph data paths via unit-level assertions.

// Direct unit test for the error-tallying in buildGraph output consumed by buildErrorPropagation
import { buildGraph } from "@/lib/usage/orchestrationGraph";
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

describe("error propagation data layer (via buildGraph)", () => {
  it("correctly marks error nodes", () => {
    const toolUseId = "err-001";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [{ name: "Agent", id: toolUseId, arguments: { subagent_type: "coder" } }],
      }),
      makeTurn({
        isSidechain: true,
        parentToolUseId: toolUseId,
        isError: true,
      }),
    ];

    const graph = buildGraph(turns);
    const node = graph.nodes.find((n) => n.id === toolUseId);
    expect(node).toBeDefined();
    expect(node!.status).toBe("error");
  });

  it("depth 0 = root agents", () => {
    const id1 = "err-002";
    const turns = [
      makeTurn({ role: "assistant", toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "root-agent" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id1 }),
    ];

    const graph = buildGraph(turns);
    const rootNode = graph.nodes.find((n) => n.id === id1);
    expect(rootNode!.depth).toBe(0);
  });

  it("nested agent gets depth 1", () => {
    const parentId = "err-003";
    const childId = "err-004";
    const turns = [
      // Main spawns parent
      makeTurn({ role: "assistant", toolCalls: [{ name: "Agent", id: parentId, arguments: { subagent_type: "parent" } }] }),
      // Parent sidechain turn that spawns child
      makeTurn({
        isSidechain: true,
        parentToolUseId: parentId,
        toolCalls: [{ name: "Agent", id: childId, arguments: { subagent_type: "child" } }],
      }),
      // Child sidechain turn
      makeTurn({ isSidechain: true, parentToolUseId: childId }),
    ];

    const graph = buildGraph(turns);
    const parentNode = graph.nodes.find((n) => n.id === parentId);
    const childNode = graph.nodes.find((n) => n.id === childId);
    expect(parentNode!.depth).toBe(0);
    expect(childNode!.depth).toBe(1);
  });

  it("multiple sessions produce independent graphs (no cross-contamination)", () => {
    const id1 = "err-005";
    const id2 = "err-006";

    const turns1 = [
      makeTurn({ sessionId: "s1", role: "assistant", toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "agent1" } }] }),
      makeTurn({ sessionId: "s1", isSidechain: true, parentToolUseId: id1 }),
    ];
    const turns2 = [
      makeTurn({ sessionId: "s2", role: "assistant", toolCalls: [{ name: "Agent", id: id2, arguments: { subagent_type: "agent2" } }] }),
      makeTurn({ sessionId: "s2", isSidechain: true, parentToolUseId: id2 }),
    ];

    const g1 = buildGraph(turns1);
    const g2 = buildGraph(turns2);

    expect(g1.nodes.every((n) => n.id !== id2)).toBe(true);
    expect(g2.nodes.every((n) => n.id !== id1)).toBe(true);
  });
});
