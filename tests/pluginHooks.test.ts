import { describe, it, expect, vi, beforeEach } from "vitest";

const norm = (p: string) => p.replace(/\\/g, "/");

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/indexer/walkPlugins", () => ({
  loadInstalledPlugins: vi.fn(),
}));

import { promises as fs } from "fs";
import { loadInstalledPlugins } from "@/lib/indexer/walkPlugins";
import { readPluginScopeHooks } from "@/lib/scanner/pluginHooks";

const mockReadFile = vi.mocked(fs.readFile);
const mockLoadInstalled = vi.mocked(loadInstalledPlugins);

beforeEach(() => vi.clearAllMocks());

function makeInstalled(name: string, installPath: string) {
  return {
    pluginName: name,
    marketplace: "anthropics/claude-plugins-official",
    installPath,
    version: "1.0.0",
    installedAt: "2025-01-01T00:00:00Z",
    lastUpdated: "2025-01-01T00:00:00Z",
    gitCommitSha: undefined,
    pluginRepoUrl: undefined,
  };
}

describe("readPluginScopeHooks", () => {
  it("returns empty array when no plugins installed", async () => {
    const result = await readPluginScopeHooks([]);
    expect(result).toEqual([]);
  });

  it("returns entries with source=plugin for plugin with valid hooks.json", async () => {
    const installPath = "/home/.claude/plugins/cache/official/my-plugin/1.0.0";
    mockReadFile.mockImplementation(async (p) => {
      if (norm(p as string).includes("my-plugin")) {
        return JSON.stringify({
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [{ type: "command", command: "npm run lint" }],
            },
          ],
        });
      }
      throw new Error("ENOENT");
    });

    const result = await readPluginScopeHooks([makeInstalled("my-plugin", installPath)]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("plugin");
    expect(norm(result[0].sourcePath)).toContain("hooks/hooks.json");
    expect(result[0].event).toBe("PostToolUse");
    expect(result[0].commands[0].command).toBe("npm run lint");
  });

  it("returns empty when plugin has no hooks/ dir", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await readPluginScopeHooks([
      makeInstalled("no-hooks-plugin", "/install/no-hooks"),
    ]);
    expect(result).toEqual([]);
  });

  it("skips plugin with malformed JSON without throwing", async () => {
    mockReadFile.mockResolvedValue("{ this is not valid json !!!");
    const result = await readPluginScopeHooks([
      makeInstalled("bad-plugin", "/install/bad"),
    ]);
    expect(result).toEqual([]);
  });

  it("surfaces entries from both plugins when two plugins have overlapping hook events", async () => {
    const path1 = "/install/plugin-a";
    const path2 = "/install/plugin-b";
    mockReadFile.mockImplementation(async (p) => {
      const s = norm(p as string);
      if (s.includes("plugin-a")) {
        return JSON.stringify({
          SessionStart: [{ hooks: [{ type: "command", command: "plugin-a-cmd" }] }],
        });
      }
      if (s.includes("plugin-b")) {
        return JSON.stringify({
          SessionStart: [{ hooks: [{ type: "command", command: "plugin-b-cmd" }] }],
        });
      }
      throw new Error("ENOENT");
    });

    const result = await readPluginScopeHooks([
      makeInstalled("plugin-a", path1),
      makeInstalled("plugin-b", path2),
    ]);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.event === "SessionStart")).toBe(true);
    expect(result.every((e) => e.source === "plugin")).toBe(true);
    const commands = result.map((e) => e.commands[0].command);
    expect(commands).toContain("plugin-a-cmd");
    expect(commands).toContain("plugin-b-cmd");
  });

  it("falls back to loadInstalledPlugins when installed not provided", async () => {
    mockLoadInstalled.mockResolvedValue([]);
    const result = await readPluginScopeHooks();
    expect(mockLoadInstalled).toHaveBeenCalledOnce();
    expect(result).toEqual([]);
  });
});
