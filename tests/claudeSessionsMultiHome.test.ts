import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";

// Multi-home correlation: a session recorded INSIDE a WSL distro (Linux cwd,
// Linux-encoded session dir, distro-local ~/.claude) must light up the
// UNC-scanned project on the dashboard. Mock fs + config so the primary home
// is empty and the WSL home holds the history.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

// Keep parseWslUncPath real (pure/sync — scopeMappingsToHome needs it) but
// stub checkWslRoot so never-wake gating never spawns wsl.exe in tests.
vi.mock("@/lib/wsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wsl")>();
  return { ...actual, checkWslRoot: vi.fn().mockResolvedValue(null) };
});

import { promises as fs } from "fs";
import { readConfig } from "@/lib/config";

const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir) as unknown as ReturnType<typeof vi.fn>;
const mockStat = vi.mocked(fs.stat);
const mockReadConfig = vi.mocked(readConfig);

const WSL_HOME = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\.claude";
const UNC_PROJECT = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev\\bamcli";
const PRIMARY_HOME = path.join(os.homedir(), ".claude");

const originalPlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  mockStat.mockRejectedValue(new Error("ENOENT"));

  mockReadConfig.mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    pinnedSlugs: [],
    claudeHomes: [WSL_HOME],
    pathMappings: [{ from: "/home/josh", to: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh" }],
  });

  // Primary home: no history, no projects. WSL home: one session recorded
  // against the Linux path, session dir encoded from that Linux path.
  mockReadFile.mockImplementation(async (p: unknown) => {
    const file = String(p);
    if (file === path.join(WSL_HOME, "history.jsonl")) {
      return (
        JSON.stringify({
          project: "/home/josh/dev/bamcli",
          display: "fix the CLI parser",
          timestamp: "2026-07-01T10:00:00.000Z",
          sessionId: "wsl-sess-1",
        }) + "\n"
      );
    }
    throw new Error("ENOENT");
  });
  mockReaddir.mockImplementation(async (p: unknown) => {
    const dir = String(p);
    if (dir === path.join(WSL_HOME, "projects")) return ["-home-josh-dev-bamcli"];
    if (dir === path.join(PRIMARY_HOME, "projects")) return [];
    throw new Error("ENOENT");
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("scanClaudeSessions — multi-home WSL correlation", () => {
  it("matches a WSL-recorded session to the UNC-scanned project via pathMappings", async () => {
    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions(UNC_PROJECT);

    expect(result.sessionCount).toBe(1);
    expect(result.lastPromptPreview).toBe("fix the CLI parser");
    expect(result.lastSessionDate).toBe("2026-07-01T10:00:00.000Z");
    expect(result.mostRecentSessionId).toBe("wsl-sess-1");
  });

  it("reads the session JSONL from the owning home's Linux-encoded dir", async () => {
    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    await scanClaudeSessions(UNC_PROJECT);

    // Status inference must target <wsl-home>/projects/<linux-encoded>/<id>.jsonl —
    // encoding the UNC path instead would miss the on-disk dir entirely.
    const statTargets = mockStat.mock.calls.map((c) => String(c[0]));
    expect(statTargets).toContain(
      path.join(WSL_HOME, "projects", "-home-josh-dev-bamcli", "wsl-sess-1.jsonl")
    );
  });

  it("finds nothing for the UNC project when no mapping is configured", async () => {
    mockReadConfig.mockResolvedValue({
      statuses: {},
      hidden: [],
      portOverrides: {},
      devRoot: "C:\\dev",
      pinnedSlugs: [],
      claudeHomes: [WSL_HOME],
      // no pathMappings — Linux-recorded path can't correlate
    });
    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions(UNC_PROJECT);
    expect(result.sessionCount).toBe(0);
  });

  it("still counts primary-home sessions for local projects", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file === path.join(PRIMARY_HOME, "history.jsonl")) {
        return (
          JSON.stringify({
            project: "C:\\dev\\my-app",
            display: "local work",
            timestamp: "2026-07-02T10:00:00.000Z",
            sessionId: "local-1",
          }) + "\n"
        );
      }
      throw new Error("ENOENT");
    });
    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions("C:\\dev\\my-app");
    expect(result.sessionCount).toBe(1);
    expect(result.mostRecentSessionId).toBe("local-1");
  });

  it("counts WSL worktree session dirs against the UNC project", async () => {
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = String(p);
      if (dir === path.join(WSL_HOME, "projects")) {
        return ["-home-josh-dev-bamcli", "-home-josh-dev-bamcli--claude-worktrees-agent-x"];
      }
      if (dir === path.join(WSL_HOME, "projects", "-home-josh-dev-bamcli--claude-worktrees-agent-x")) {
        return ["wt-sess.jsonl", "notes.txt"];
      }
      if (dir === path.join(PRIMARY_HOME, "projects")) return [];
      throw new Error("ENOENT");
    });
    const { scanClaudeSessions } = await import("@/lib/scanner/claudeSessions");
    const result = await scanClaudeSessions(UNC_PROJECT);
    // 1 history session + 1 worktree JSONL
    expect(result.sessionCount).toBe(2);
  });
});
