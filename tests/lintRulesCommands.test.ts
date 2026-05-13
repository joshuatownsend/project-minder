import { describe, it, expect } from "vitest";
import { runCommandRules, runCommandDuplicateSlugs } from "@/lib/lint/rules/commands";
import type { CommandEntry } from "@/lib/types";

function makeCommand(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: "command:user:user:my-cmd",
    slug: "my-cmd",
    name: "my-cmd",
    source: "user",
    filePath: "/home/.claude/commands/my-cmd.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: new Date().toISOString(),
    ctime: new Date().toISOString(),
    ...overrides,
  };
}

describe("runCommandRules", () => {
  it("emits missing-description for command with no description", () => {
    const findings = runCommandRules([makeCommand({ description: undefined })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("command/missing-description");
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].file).toBe("/home/.claude/commands/my-cmd.md");
  });

  it("emits nothing when description is present", () => {
    const findings = runCommandRules([makeCommand({ description: "Runs the linter." })]);
    expect(findings).toHaveLength(0);
  });
});

describe("runCommandDuplicateSlugs", () => {
  it("emits duplicate-slug when same slug exists in multiple scopes", () => {
    const findings = runCommandDuplicateSlugs([
      makeCommand({ slug: "deploy", source: "user" }),
      makeCommand({ slug: "deploy", source: "project", projectSlug: "my-proj" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("command/duplicate-slug");
    expect(findings[0].severity).toBe("P1");
  });

  it("emits nothing when all slugs are unique", () => {
    const findings = runCommandDuplicateSlugs([
      makeCommand({ slug: "build" }),
      makeCommand({ slug: "test" }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it("emits one finding per duplicate group", () => {
    const findings = runCommandDuplicateSlugs([
      makeCommand({ slug: "fix", source: "user" }),
      makeCommand({ slug: "fix", source: "plugin" }),
      makeCommand({ slug: "fix", source: "project" }),
    ]);
    expect(findings).toHaveLength(1);
  });
});
