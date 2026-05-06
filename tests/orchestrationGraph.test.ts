import { describe, it, expect } from "vitest";
import { buildGraph } from "@/lib/usage/orchestrationGraph";
import type { UsageTurn } from "@/lib/usage/types";

function mainTurn(tools: Array<{ name: string; id: string; agentName?: string }>): UsageTurn {
  return {
    sessionId: "s1",
    projectSlug: "test",
    projectDirName: "test",
    timestamp: "2026-01-01T00:00:00Z",
    role: "assistant",
    model: "claude-sonnet-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    isSidechain: false,
    toolCalls: tools.map(({ name, id, agentName }) => ({
      name,
      id,
      arguments: agentName ? { subagent_type: agentName } : {},
    })),
  } as UsageTurn;
}

function sidechainTurn(
  parentToolUseId: string,
  tools: Array<{ name: string; id?: string; agentName?: string }> = [],
  isError = false
): UsageTurn {
  return {
    sessionId: "s1",
    projectSlug: "test",
    projectDirName: "test",
    timestamp: "2026-01-01T00:01:00Z",
    role: "assistant",
    model: "claude-sonnet-4-5",
    inputTokens: 50,
    outputTokens: 25,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    isSidechain: true,
    parentToolUseId,
    isError,
    toolCalls: tools.map(({ name, id, agentName }) => ({
      name,
      id,
      arguments: agentName ? { subagent_type: agentName } : {},
    })),
  } as UsageTurn;
}

describe("buildGraph", () => {
  it("returns empty graph for empty turns", () => {
    const g = buildGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.rootCount).toBe(0);
  });

  it("returns empty graph for session with no subagents", () => {
    const turns = [
      mainTurn([{ name: "Read", id: "tc1" }, { name: "Edit", id: "tc2" }]),
    ];
    const g = buildGraph(turns);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.rootCount).toBe(0);
  });

  it("builds a flat graph for one spawned agent", () => {
    const turns = [
      mainTurn([{ name: "Agent", id: "task1", agentName: "code-reviewer" }]),
      sidechainTurn("task1", [{ name: "Read", id: "r1" }]),
    ];
    const g = buildGraph(turns);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id: "task1", agentName: "code-reviewer", depth: 0 });
    expect(g.edges).toHaveLength(0);
    expect(g.rootCount).toBe(1);
  });

  it("resolves agentName from main turn Agent call", () => {
    const turns = [
      mainTurn([{ name: "Agent", id: "task1", agentName: "gsd-executor" }]),
      sidechainTurn("task1"),
    ];
    const g = buildGraph(turns);
    expect(g.nodes[0].agentName).toBe("gsd-executor");
  });

  it("marks errored sidechain node as status=error", () => {
    const turns = [
      mainTurn([{ name: "Agent", id: "task1", agentName: "analyzer" }]),
      sidechainTurn("task1", [], true),
    ];
    const g = buildGraph(turns);
    expect(g.nodes[0].status).toBe("error");
  });

  it("marks non-errored sidechain node as status=ok", () => {
    const turns = [
      mainTurn([{ name: "Agent", id: "task1", agentName: "analyzer" }]),
      sidechainTurn("task1"),
    ];
    const g = buildGraph(turns);
    expect(g.nodes[0].status).toBe("ok");
  });

  it("builds parent→child edge for nested Task spawn", () => {
    const turns = [
      mainTurn([{ name: "Agent", id: "task1", agentName: "orchestrator" }]),
      sidechainTurn("task1", [{ name: "Agent", id: "task2", agentName: "worker" }]),
      sidechainTurn("task2"),
    ];
    const g = buildGraph(turns);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ from: "task1", to: "task2" }]);
    const parent = g.nodes.find((n) => n.id === "task1");
    const child = g.nodes.find((n) => n.id === "task2");
    expect(parent?.depth).toBe(0);
    expect(child?.depth).toBe(1);
  });

  it("emits +N more placeholder when depth exceeds cap", () => {
    // Build a chain 8 levels deep (0..7); levels 7+ should be capped
    let turns: UsageTurn[] = [];
    turns.push(mainTurn([{ name: "Agent", id: "t0", agentName: "a0" }]));
    for (let i = 0; i < 7; i++) {
      turns.push(
        sidechainTurn(`t${i}`, [{ name: "Agent", id: `t${i + 1}`, agentName: `a${i + 1}` }])
      );
    }
    // Final leaf with no children
    turns.push(sidechainTurn("t7"));

    const g = buildGraph(turns);
    const overflow = g.nodes.find((n) => n.toolName.startsWith("+"));
    expect(overflow).toBeDefined();
    expect(overflow?.toolName).toMatch(/^\+\d+ more$/);
    // Visible nodes should have depth <= 6
    const visibleNodes = g.nodes.filter((n) => !n.toolName.startsWith("+"));
    for (const n of visibleNodes) {
      expect(n.depth).toBeLessThanOrEqual(6);
    }
  });

  it("rootCount equals number of nodes with no parent", () => {
    const turns = [
      mainTurn([
        { name: "Agent", id: "task1", agentName: "a1" },
        { name: "Agent", id: "task2", agentName: "a2" },
      ]),
      sidechainTurn("task1"),
      sidechainTurn("task2"),
    ];
    const g = buildGraph(turns);
    expect(g.rootCount).toBe(2);
  });
});
