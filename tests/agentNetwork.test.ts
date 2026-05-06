import { describe, it, expect } from "vitest";
import { buildAgentNetwork } from "@/lib/usage/agentNetwork";
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

describe("buildAgentNetwork", () => {
  it("returns empty report when no sidechains", () => {
    const turns = [makeTurn({ role: "user" }), makeTurn({})];
    const result = buildAgentNetwork(turns);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("produces main node + 1 agent node for single subagent", () => {
    const toolUseId = "net-001";
    const turns = [
      makeTurn({
        role: "assistant",
        toolCalls: [{ name: "Agent", id: toolUseId, arguments: { subagent_type: "code-reviewer" } }],
      }),
      makeTurn({ isSidechain: true, parentToolUseId: toolUseId }),
      makeTurn({ isSidechain: true, parentToolUseId: toolUseId }),
    ];

    const result = buildAgentNetwork(turns);
    expect(result.nodes.some((n) => n.id === "main")).toBe(true);
    expect(result.nodes.some((n) => n.id === "code-reviewer")).toBe(true);

    const agentNode = result.nodes.find((n) => n.id === "code-reviewer")!;
    expect(agentNode.messageCount).toBe(2);

    const edge = result.edges.find((e) => e.from === "main" && e.to === "code-reviewer");
    expect(edge).toBeDefined();
  });

  it("collapses multiple invocations of same agent into one node", () => {
    const id1 = "net-002";
    const id2 = "net-003";
    const turns = [
      makeTurn({ role: "assistant", toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "helper" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id1 }),
      makeTurn({ role: "assistant", toolCalls: [{ name: "Agent", id: id2, arguments: { subagent_type: "helper" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id2 }),
    ];

    const result = buildAgentNetwork(turns);
    const helperNodes = result.nodes.filter((n) => n.id === "helper");
    expect(helperNodes).toHaveLength(1);
    expect(helperNodes[0].messageCount).toBe(2);
  });

  it("does not produce self-edges from same agent to same agent", () => {
    const id1 = "net-004";
    const turns = [
      makeTurn({ role: "assistant", toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "planner" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id1 }),
    ];

    const result = buildAgentNetwork(turns);
    const selfEdges = result.edges.filter((e) => e.from === e.to);
    expect(selfEdges).toHaveLength(0);
  });

  it("produces edge from main to each root-level agent", () => {
    const id1 = "net-005";
    const id2 = "net-006";
    const turns = [
      makeTurn({ role: "assistant", toolCalls: [
        { name: "Agent", id: id1, arguments: { subagent_type: "agent-A" } },
        { name: "Agent", id: id2, arguments: { subagent_type: "agent-B" } },
      ]}),
      makeTurn({ isSidechain: true, parentToolUseId: id1 }),
      makeTurn({ isSidechain: true, parentToolUseId: id2 }),
    ];

    const result = buildAgentNetwork(turns);
    expect(result.edges.some((e) => e.from === "main" && e.to === "agent-A")).toBe(true);
    expect(result.edges.some((e) => e.from === "main" && e.to === "agent-B")).toBe(true);
  });
});
