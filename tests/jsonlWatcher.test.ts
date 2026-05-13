import { describe, it, expect } from "vitest";
import { parseJsonlPath } from "@/lib/agentView/jsonlWatcher";
import path from "path";

// Use POSIX-encoded Claude project dirs throughout so tests are platform-agnostic.
// Claude encodes project paths by replacing separators with "-", so:
//   /home/user/dev/myapp  →  -home-user-dev-myapp
// path.basename(decodeDirName("-home-user-dev-myapp")) = "myapp" on all platforms
// because decodeDirName converts dashes to forward slashes, which both path modules
// recognize as separators.
const PROJECTS_DIR = "/home/user/.claude/projects";

describe("parseJsonlPath", () => {
  it("returns null for non-jsonl files", () => {
    const filePath = path.join(PROJECTS_DIR, "-home-user-dev-myapp", "session.txt");
    expect(parseJsonlPath(PROJECTS_DIR, filePath)).toBeNull();
  });

  it("returns null for files not two levels deep", () => {
    const filePath = path.join(PROJECTS_DIR, "orphan.jsonl");
    expect(parseJsonlPath(PROJECTS_DIR, filePath)).toBeNull();
  });

  it("parses a simple encoded project dir", () => {
    const filePath = path.join(PROJECTS_DIR, "-home-user-dev-myapp", "abc123.jsonl");
    const result = parseJsonlPath(PROJECTS_DIR, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("abc123");
    expect(result!.projectSlug).toBe("myapp");
  });

  it("parses a hyphenated project name (slug is lossy — basename of decoded path)", () => {
    // Claude encodes /home/user/dev/project-minder as -home-user-dev-project-minder.
    // All dashes decode to slashes, so basename = "minder" (same as liveStatus.ts).
    const filePath = path.join(PROJECTS_DIR, "-home-user-dev-project-minder", "sess999.jsonl");
    const result = parseJsonlPath(PROJECTS_DIR, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess999");
    expect(result!.projectSlug).toBe("minder");
  });

  it("strips worktree suffix before decoding the project slug", () => {
    const worktreeDir = "-home-user-dev-project-minder--claude-worktrees-my-branch";
    const filePath = path.join(PROJECTS_DIR, worktreeDir, "wt123.jsonl");
    const result = parseJsonlPath(PROJECTS_DIR, filePath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("wt123");
    // Worktree suffix stripped → dir "-home-user-dev-project-minder" → slug "minder"
    expect(result!.projectSlug).toBe("minder");
    expect(result!.projectSlug).not.toContain("branch");
  });

  it("returns null for a .jsonl file nested three levels deep", () => {
    const filePath = path.join(PROJECTS_DIR, "-home-user-dev-myapp", "subdir", "abc.jsonl");
    expect(parseJsonlPath(PROJECTS_DIR, filePath)).toBeNull();
  });
});
