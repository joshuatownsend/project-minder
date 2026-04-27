import { describe, it, expect } from "vitest";
import { buildAgentAliasMap, buildSkillAliasMap, lookupEntry } from "@/lib/indexer/canonicalize";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "user:user:test-agent",
    slug: "test-agent",
    name: "Test Agent",
    source: "user",
    filePath: "/fake/test-agent.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: "",
    ctime: "",
    kind: "agent",
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: "user:user:my-skill",
    slug: "my-skill",
    name: "My Skill",
    source: "user",
    filePath: "/fake/my-skill/SKILL.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: "",
    ctime: "",
    kind: "skill",
    layout: "bundled",
    ...overrides,
  };
}

describe("buildAgentAliasMap", () => {
  it("looks up by slug", () => {
    const agent = makeAgent();
    const map = buildAgentAliasMap([agent]);
    expect(lookupEntry(map, "test-agent")).toBe(agent);
  });

  it("looks up by name (case-insensitive)", () => {
    const agent = makeAgent();
    const map = buildAgentAliasMap([agent]);
    expect(lookupEntry(map, "test agent")).toBe(agent);
    expect(lookupEntry(map, "TEST AGENT")).toBe(agent);
  });

  it("looks up plugin agent by pluginName:slug", () => {
    const agent = makeAgent({
      source: "plugin",
      pluginName: "feature-dev",
      slug: "code-reviewer",
      id: "plugin:feature-dev:code-reviewer",
    });
    const map = buildAgentAliasMap([agent]);
    expect(lookupEntry(map, "feature-dev:code-reviewer")).toBe(agent);
  });

  it("returns undefined for unknown name", () => {
    const map = buildAgentAliasMap([makeAgent()]);
    expect(lookupEntry(map, "nonexistent")).toBeUndefined();
  });
});

describe("buildSkillAliasMap", () => {
  it("looks up by slug", () => {
    const skill = makeSkill();
    const map = buildSkillAliasMap([skill]);
    expect(lookupEntry(map, "my-skill")).toBe(skill);
  });

  it("looks up plugin skill by pluginName:slug", () => {
    const skill = makeSkill({
      source: "plugin",
      pluginName: "vercel",
      slug: "nextjs",
      id: "plugin:vercel:nextjs",
    });
    const map = buildSkillAliasMap([skill]);
    expect(lookupEntry(map, "vercel:nextjs")).toBe(skill);
  });

  it("is case-insensitive", () => {
    const skill = makeSkill({ slug: "Simplify", name: "Simplify" });
    const map = buildSkillAliasMap([skill]);
    expect(lookupEntry(map, "simplify")).toBe(skill);
  });
});
