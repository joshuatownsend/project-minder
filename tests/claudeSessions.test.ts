import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// scanClaudeSessions reads ~/.claude/history.jsonl and lists
// ~/.claude/projects/. Mock fs so we control both without touching disk.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir) as unknown as ReturnType<typeof vi.fn>;
const mockStat = vi.mocked(fs.stat);

const originalPlatform = process.platform;

describe("scanClaudeSessions — case-insensitive session lookup (B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // B1 case-folding is Windows-only (POSIX paths are case-sensitive, so
    // folding is intentionally off there — PR #251 review). Simulate win32
    // before the dynamic import below so platform.ts's `isWindows` gate is on
    // when this runs on a Linux CI runner.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mockStat.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("matches a session whose recorded project path differs only in case from the scanned dir", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file.endsWith("history.jsonl")) {
        return (
          JSON.stringify({
            project: "c:\\dev\\myapp", // lowercase drive letter, recorded by history.jsonl
            display: "hello world",
            timestamp: "2026-01-01T00:00:00.000Z",
            sessionId: "sess-1",
          }) + "\n"
        );
      }
      throw new Error("ENOENT");
    });
    mockReaddir.mockResolvedValue([]);

    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    // Scanned dir uses different case than history.jsonl's recorded project.
    const result = await scanClaudeSessions("C:\\Dev\\MyApp");

    expect(result.sessionCount).toBe(1);
    expect(result.lastPromptPreview).toBe("hello world");
    expect(result.lastSessionDate).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not match when history.jsonl records an entirely different project", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file.endsWith("history.jsonl")) {
        return (
          JSON.stringify({
            project: "C:\\dev\\other-app",
            display: "hi",
            timestamp: "2026-01-01T00:00:00.000Z",
          }) + "\n"
        );
      }
      throw new Error("ENOENT");
    });
    mockReaddir.mockResolvedValue([]);

    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions("C:\\dev\\myapp");
    expect(result.sessionCount).toBe(0);
  });

  it("counts worktree sessions whose on-disk encoded dir name differs only in case from the parent", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file.endsWith("history.jsonl")) return ""; // no top-level history entries
      throw new Error("ENOENT");
    });
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = String(p);
      if (dir.toLowerCase().endsWith("projects")) {
        // Encoded with a lowercase drive letter, unlike the scanned path below.
        return ["c--dev-myapp--claude-worktrees-feature-x"];
      }
      // Listing inside the worktree's session directory.
      return ["abc123.jsonl"];
    });

    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions("C:\\dev\\myapp");
    expect(result.sessionCount).toBe(1);
  });
});
