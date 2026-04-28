import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { walkProjectCommands } from "@/lib/indexer/walkCommands";

let tmp: string;
let projectPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkCmd-test-"));
  projectPath = path.join(tmp, "proj");
  await fs.mkdir(path.join(projectPath, ".claude", "commands"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("walkProjectCommands", () => {
  it("returns [] when commands directory is missing", async () => {
    const noCmdProject = path.join(tmp, "nocmd");
    await fs.mkdir(noCmdProject, { recursive: true });
    const result = await walkProjectCommands(noCmdProject, "nocmd");
    expect(result).toEqual([]);
  });

  it("parses a basic command file with frontmatter", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "commands", "generate-tests.md"),
      `---
name: Generate Tests
description: Generate vitest tests for a target file.
allowed-tools: Read, Write, Edit, Bash
argument-hint: "[file-path]"
---

# Generate tests

Body of the command.`,
      "utf-8"
    );

    const result = await walkProjectCommands(projectPath, "proj");
    expect(result).toHaveLength(1);
    const cmd = result[0];
    expect(cmd.slug).toBe("generate-tests");
    expect(cmd.name).toBe("Generate Tests");
    expect(cmd.description).toBe("Generate vitest tests for a target file.");
    expect(cmd.allowedTools).toEqual(["Read", "Write", "Edit", "Bash"]);
    expect(cmd.argumentHint).toBe("[file-path]");
    expect(cmd.source).toBe("project");
    expect(cmd.projectSlug).toBe("proj");
    expect(cmd.id).toBe("command:project:proj:generate-tests");
  });

  it("falls back to filename slug when frontmatter has no name", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "commands", "no-name.md"),
      "no frontmatter at all",
      "utf-8"
    );
    const result = await walkProjectCommands(projectPath, "proj");
    expect(result[0].slug).toBe("no-name");
    expect(result[0].name).toBe("no-name");
  });

  it("walks subdirectories and tags `category` from depth=1", async () => {
    await fs.mkdir(path.join(projectPath, ".claude", "commands", "git"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".claude", "commands", "git", "commit.md"),
      "---\nname: commit\n---\nbody",
      "utf-8"
    );
    const result = await walkProjectCommands(projectPath, "proj");
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("git");
    expect(result[0].id).toBe("command:project:proj:git/commit");
  });

  it("ignores .tmpl files and dotfiles", async () => {
    await fs.writeFile(path.join(projectPath, ".claude", "commands", "x.md.tmpl"), "skip", "utf-8");
    await fs.writeFile(path.join(projectPath, ".claude", "commands", ".hidden.md"), "skip", "utf-8");
    await fs.writeFile(path.join(projectPath, ".claude", "commands", "real.md"), "keep", "utf-8");
    const result = await walkProjectCommands(projectPath, "proj");
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("real");
  });

  it("parses array form of allowed-tools", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "commands", "arr.md"),
      "---\nname: arr\nallowed-tools:\n  - Read\n  - Write\n---\nbody",
      "utf-8"
    );
    const result = await walkProjectCommands(projectPath, "proj");
    expect(result[0].allowedTools).toEqual(["Read", "Write"]);
  });
});
