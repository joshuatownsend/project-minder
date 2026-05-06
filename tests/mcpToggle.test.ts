import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("@/lib/configHistory", () => ({
  recordPreWrite: vi.fn().mockResolvedValue(null),
}));

import { promises as fs } from "fs";
import { toggleProjectMcpServer } from "@/lib/mcpToggle";

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockRename = vi.mocked(fs.rename);
const mockMkdir = vi.mocked(fs.mkdir);

function settingsPath(projectPath: string) {
  return path.join(projectPath, ".claude", "settings.local.json");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  // writeFileAtomic uses writeFile + rename
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
});

describe("toggleProjectMcpServer", () => {
  const PROJECT = "/home/user/dev/my-app";

  describe("disable (enabled=false)", () => {
    it("adds server to disabledMcpjsonServers when not present", async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ someOtherKey: true }));

      const { disabledList } = await toggleProjectMcpServer(PROJECT, "github", false);
      expect(disabledList).toContain("github");

      // Verify the written JSON contains the server
      const written = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.disabledMcpjsonServers).toContain("github");
    });

    it("does not duplicate when already disabled", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ disabledMcpjsonServers: ["github"] })
      );

      const { disabledList } = await toggleProjectMcpServer(PROJECT, "github", false);
      expect(disabledList.filter((n: string) => n === "github")).toHaveLength(1);
    });

    it("starts with empty list when file doesn't exist", async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" }));

      const { disabledList } = await toggleProjectMcpServer(PROJECT, "memory", false);
      expect(disabledList).toEqual(["memory"]);
    });
  });

  describe("enable (enabled=true)", () => {
    it("removes server from disabledMcpjsonServers", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ disabledMcpjsonServers: ["github", "memory"] })
      );

      const { disabledList } = await toggleProjectMcpServer(PROJECT, "github", true);
      expect(disabledList).not.toContain("github");
      expect(disabledList).toContain("memory");
    });

    it("no-ops when server is not in disabled list", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ disabledMcpjsonServers: ["memory"] })
      );

      const { disabledList } = await toggleProjectMcpServer(PROJECT, "github", true);
      expect(disabledList).toEqual(["memory"]);
    });
  });

  it("preserves other keys in settings file", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ hooks: { PreToolUse: [] }, disabledMcpjsonServers: [] })
    );

    await toggleProjectMcpServer(PROJECT, "github", false);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.hooks).toBeDefined();
    expect(parsed.disabledMcpjsonServers).toContain("github");
  });
});
