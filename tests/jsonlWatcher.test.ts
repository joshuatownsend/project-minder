import { describe, it, expect } from "vitest";
import { parseJsonlPath } from "@/lib/agentView/jsonlWatcher";
import path from "path";

const WIN_PROJECTS = "C:\\Users\\user\\.claude\\projects";
const UNIX_PROJECTS = "/home/user/.claude/projects";

describe("parseJsonlPath", () => {
  it("returns null for non-jsonl files", () => {
    expect(parseJsonlPath(WIN_PROJECTS, path.join(WIN_PROJECTS, "C-dev-proj", "session.txt"))).toBeNull();
  });

  it("returns null for files not two levels deep", () => {
    // File directly in projectsDir
    expect(parseJsonlPath(WIN_PROJECTS, path.join(WIN_PROJECTS, "orphan.jsonl"))).toBeNull();
  });

  it("parses a Windows-encoded project dir correctly", () => {
    const filePath = path.join(WIN_PROJECTS, "C-dev-project-minder", "abc123.jsonl");
    const result = parseJsonlPath(WIN_PROJECTS, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("abc123");
    // decodeDirName converts all dashes to separators, so basename = "minder"
    expect(result!.projectSlug).toBe("minder");
  });

  it("parses a Unix-encoded project dir correctly", () => {
    const filePath = path.join(UNIX_PROJECTS, "-home-user-dev-myapp", "sess999.jsonl");
    const result = parseJsonlPath(UNIX_PROJECTS, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess999");
    expect(result!.projectSlug).toContain("myapp");
  });

  it("strips worktree suffix before decoding the project slug", () => {
    // WORKTREE_SEP = "--claude-worktrees-"
    const worktreeDir = "C-dev-project-minder--claude-worktrees-my-branch";
    const filePath = path.join(WIN_PROJECTS, worktreeDir, "wt123.jsonl");
    const result = parseJsonlPath(WIN_PROJECTS, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("wt123");
    // WORKTREE_SEP stripped → decoded dir is "C-dev-project-minder" → basename "minder"
    expect(result!.projectSlug).toBe("minder");
    expect(result!.projectSlug).not.toContain("branch");
  });

  it("returns null for a .jsonl file nested three levels deep", () => {
    const filePath = path.join(WIN_PROJECTS, "C-dev-proj", "subdir", "abc.jsonl");
    expect(parseJsonlPath(WIN_PROJECTS, filePath)).toBeNull();
  });
});
