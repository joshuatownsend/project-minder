import { describe, it, expect } from "vitest";
import { runSkillRules, runSkillDuplicateNames } from "@/lib/lint/rules/skills";
import type { SkillEntry } from "@/lib/indexer/types";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    kind: "skill",
    id: "skill:user:user:slug",
    slug: "my-skill",
    name: "my-skill",
    source: "user",
    filePath: "/home/.claude/skills/my-skill/SKILL.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: new Date().toISOString(),
    ctime: new Date().toISOString(),
    layout: "bundled",
    provenance: { kind: "user-local" },
    ...overrides,
  };
}

describe("runSkillRules", () => {
  it("emits missing-description for skill with no description", () => {
    const findings = runSkillRules([makeSkill({ description: undefined })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("skill/missing-description");
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].file).toBe("/home/.claude/skills/my-skill/SKILL.md");
  });

  it("emits nothing when description is present and short", () => {
    const findings = runSkillRules([makeSkill({ description: "A concise description." })]);
    expect(findings).toHaveLength(0);
  });

  it("emits long-description when description exceeds 1024 chars", () => {
    const long = "x".repeat(1025);
    const findings = runSkillRules([makeSkill({ description: long })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("skill/long-description");
    expect(findings[0].severity).toBe("P2");
  });

  it("emits both findings when description is missing on one skill and too long on another", () => {
    const findings = runSkillRules([
      makeSkill({ description: undefined }),
      makeSkill({ slug: "b", name: "b", description: "y".repeat(1025) }),
    ]);
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["skill/missing-description", "skill/long-description"])
    );
  });
});

describe("runSkillDuplicateNames", () => {
  it("emits duplicate-name when same name exists in multiple scopes", () => {
    const findings = runSkillDuplicateNames([
      makeSkill({ name: "shared", source: "user" }),
      makeSkill({ name: "shared", source: "project", projectSlug: "my-proj" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("skill/duplicate-name");
    expect(findings[0].title).toMatch(/user.*project|project.*user/);
  });

  it("emits nothing when all names are unique", () => {
    const findings = runSkillDuplicateNames([
      makeSkill({ name: "alpha", source: "user" }),
      makeSkill({ name: "beta", source: "project" }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it("emits one finding per duplicate group even with 3 same-name entries", () => {
    const findings = runSkillDuplicateNames([
      makeSkill({ name: "dup", source: "user" }),
      makeSkill({ name: "dup", source: "plugin" }),
      makeSkill({ name: "dup", source: "project" }),
    ]);
    expect(findings).toHaveLength(1);
  });
});
