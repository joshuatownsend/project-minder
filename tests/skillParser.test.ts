import { describe, it, expect } from "vitest";
import { groupSkillCalls } from "@/lib/usage/skillParser";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(
  overrides: Partial<UsageTurn> & { skillName?: string; agentType?: string }
): UsageTurn {
  const { skillName, agentType, ...rest } = overrides;
  const toolCalls = skillName
    ? [{ name: "Skill", arguments: { skill: skillName } }]
    : agentType
    ? [{ name: "Agent", arguments: { subagent_type: agentType } }]
    : [];

  return {
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "sess-1",
    projectSlug: "my-project",
    projectDirName: "C--dev-my-project",
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

describe("groupSkillCalls", () => {
  it("returns empty array for no turns", () => {
    expect(groupSkillCalls([])).toEqual([]);
  });

  it("counts a single Skill call", () => {
    const result = groupSkillCalls([makeTurn({ skillName: "simplify" })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("simplify");
    expect(result[0].invocations).toBe(1);
  });

  it("groups multiple calls to the same skill", () => {
    const turns = [
      makeTurn({ skillName: "simplify" }),
      makeTurn({ skillName: "simplify", sessionId: "sess-2" }),
    ];
    const result = groupSkillCalls(turns);
    expect(result[0].invocations).toBe(2);
    expect(result[0].sessions).toHaveLength(2);
  });

  it("keeps plugin-namespaced skills separate from plain skills", () => {
    const turns = [
      makeTurn({ skillName: "vercel:deploy" }),
      makeTurn({ skillName: "deploy" }),
    ];
    const result = groupSkillCalls(turns);
    expect(result).toHaveLength(2);
    const names = result.map((r) => r.name);
    expect(names).toContain("vercel:deploy");
    expect(names).toContain("deploy");
  });

  it("tracks per-project counts", () => {
    const turns = [
      makeTurn({ skillName: "simplify", projectSlug: "proj-x" }),
      makeTurn({ skillName: "simplify", projectSlug: "proj-y" }),
    ];
    const result = groupSkillCalls(turns);
    expect(result[0].projects["proj-x"]).toBe(1);
    expect(result[0].projects["proj-y"]).toBe(1);
  });

  it("ignores Agent tool calls", () => {
    const result = groupSkillCalls([makeTurn({ agentType: "Explore" })]);
    expect(result).toHaveLength(0);
  });

  it("ignores non-assistant turns", () => {
    const result = groupSkillCalls([makeTurn({ skillName: "simplify", role: "user" })]);
    expect(result).toHaveLength(0);
  });

  it("sorts by invocations descending", () => {
    const turns = [
      makeTurn({ skillName: "rare" }),
      makeTurn({ skillName: "common" }),
      makeTurn({ skillName: "common", sessionId: "sess-2" }),
    ];
    const result = groupSkillCalls(turns);
    expect(result[0].name).toBe("common");
  });
});
