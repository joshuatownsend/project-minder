import { describe, it, expect } from "vitest";
import { groupAgentCalls } from "@/lib/usage/agentParser";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(
  overrides: Partial<UsageTurn> & {
    agentType?: string;
    skillName?: string;
  }
): UsageTurn {
  const { agentType, skillName, ...rest } = overrides;
  const toolCalls = agentType
    ? [{ name: "Agent", arguments: { subagent_type: agentType, description: "test" } }]
    : skillName
    ? [{ name: "Skill", arguments: { skill: skillName } }]
    : [];

  return {
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "sess-1",
    projectSlug: "project-a",
    projectDirName: "C--dev-project-a",
    model: "claude-sonnet-4-6",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls,
    ...rest,
  };
}

describe("groupAgentCalls", () => {
  it("returns empty array for no turns", () => {
    expect(groupAgentCalls([])).toEqual([]);
  });

  it("ignores non-assistant turns", () => {
    const turn = makeTurn({ role: "user", agentType: "Explore" });
    expect(groupAgentCalls([turn])).toEqual([]);
  });

  it("counts a single Agent call", () => {
    const result = groupAgentCalls([makeTurn({ agentType: "Explore" })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Explore");
    expect(result[0].invocations).toBe(1);
  });

  it("groups multiple calls to the same agent", () => {
    const turns = [
      makeTurn({ agentType: "Explore" }),
      makeTurn({ agentType: "Explore", sessionId: "sess-2" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result[0].invocations).toBe(2);
    expect(result[0].sessions).toHaveLength(2);
  });

  it("keeps agents with different subagent_type separate", () => {
    const turns = [
      makeTurn({ agentType: "Explore" }),
      makeTurn({ agentType: "code-reviewer" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result).toHaveLength(2);
  });

  it("tracks per-project counts", () => {
    const turns = [
      makeTurn({ agentType: "Explore", projectSlug: "project-a" }),
      makeTurn({ agentType: "Explore", projectSlug: "project-b" }),
      makeTurn({ agentType: "Explore", projectSlug: "project-a" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result[0].projects["project-a"]).toBe(2);
    expect(result[0].projects["project-b"]).toBe(1);
  });

  it("tracks first and last used timestamps", () => {
    const turns = [
      makeTurn({ agentType: "Explore", timestamp: "2026-01-01T00:00:00Z" }),
      makeTurn({ agentType: "Explore", timestamp: "2026-02-01T00:00:00Z" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result[0].firstUsed).toBe("2026-01-01T00:00:00Z");
    expect(result[0].lastUsed).toBe("2026-02-01T00:00:00Z");
  });

  it("deduplicates session IDs", () => {
    const turns = [
      makeTurn({ agentType: "Explore", sessionId: "same-session" }),
      makeTurn({ agentType: "Explore", sessionId: "same-session" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result[0].sessions).toHaveLength(1);
  });

  it("ignores Skill tool calls", () => {
    const result = groupAgentCalls([makeTurn({ skillName: "simplify" })]);
    expect(result).toHaveLength(0);
  });

  it("sorts by invocations descending", () => {
    const turns = [
      makeTurn({ agentType: "rare-agent" }),
      makeTurn({ agentType: "common-agent" }),
      makeTurn({ agentType: "common-agent", sessionId: "sess-2" }),
    ];
    const result = groupAgentCalls(turns);
    expect(result[0].name).toBe("common-agent");
    expect(result[1].name).toBe("rare-agent");
  });
});
