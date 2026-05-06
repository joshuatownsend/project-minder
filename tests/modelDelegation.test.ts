import { describe, it, expect } from "vitest";
import { buildModelDelegation } from "@/lib/usage/modelDelegation";
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

describe("buildModelDelegation", () => {
  it("returns empty report when no sidechains", () => {
    const turns = [makeTurn({ role: "user" }), makeTurn({})];
    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(0);
  });

  it("produces single edge for one delegation", () => {
    const toolUseId = "tuid-001";
    const turns = [
      makeTurn({
        role: "assistant",
        model: "claude-opus-4-7",
        toolCalls: [{ name: "Agent", id: toolUseId, arguments: { subagent_type: "coder" } }],
      }),
      makeTurn({
        isSidechain: true,
        parentToolUseId: toolUseId,
        model: "claude-haiku-4-5",
        inputTokens: 200,
        outputTokens: 100,
      }),
    ];

    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe("claude-opus-4-7");
    expect(result.edges[0].to).toBe("claude-haiku-4-5");
    expect(result.edges[0].count).toBe(1);
    expect(result.edges[0].tokens).toBe(300);
    expect(result.parentModels).toContain("claude-opus-4-7");
    expect(result.childModels).toContain("claude-haiku-4-5");
  });

  it("aggregates multiple sidechain turns on same edge", () => {
    const toolUseId = "tuid-002";
    const turns = [
      makeTurn({
        role: "assistant",
        model: "claude-sonnet-4-6",
        toolCalls: [{ name: "Agent", id: toolUseId, arguments: { subagent_type: "helper" } }],
      }),
      makeTurn({ isSidechain: true, parentToolUseId: toolUseId, model: "claude-haiku-4-5", inputTokens: 50, outputTokens: 25 }),
      makeTurn({ isSidechain: true, parentToolUseId: toolUseId, model: "claude-haiku-4-5", inputTokens: 50, outputTokens: 25 }),
    ];

    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].count).toBe(2);
    expect(result.edges[0].tokens).toBe(150);
  });

  it("produces multiple edges for different delegations", () => {
    const id1 = "tuid-003";
    const id2 = "tuid-004";
    const turns = [
      makeTurn({ role: "assistant", model: "claude-opus-4-7", toolCalls: [{ name: "Agent", id: id1, arguments: { subagent_type: "a" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id1, model: "claude-haiku-4-5" }),
      makeTurn({ role: "assistant", model: "claude-opus-4-7", toolCalls: [{ name: "Agent", id: id2, arguments: { subagent_type: "b" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: id2, model: "claude-sonnet-4-6" }),
    ];

    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(2);
  });

  it("ignores sidechain turns with no matching parent", () => {
    const turns = [
      makeTurn({ isSidechain: true, parentToolUseId: "missing-id", model: "claude-haiku-4-5" }),
    ];
    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(0);
  });

  it("handles same-model self-delegation", () => {
    const toolUseId = "tuid-self";
    const turns = [
      makeTurn({ role: "assistant", model: "claude-opus-4-7", toolCalls: [{ name: "Agent", id: toolUseId, arguments: { subagent_type: "sub" } }] }),
      makeTurn({ isSidechain: true, parentToolUseId: toolUseId, model: "claude-opus-4-7" }),
    ];
    const result = buildModelDelegation(turns);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe(result.edges[0].to);
  });
});
