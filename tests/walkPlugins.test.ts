import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { loadInstalledPlugins } from "@/lib/indexer/walkPlugins";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

function makePluginsFile(plugins: Record<string, unknown>) {
  return JSON.stringify({ version: 1, plugins });
}

// Default plugin.json reads always fail (no repo URL) unless overridden
const NO_PLUGIN_JSON = new Error("ENOENT");

describe("loadInstalledPlugins", () => {
  it("returns empty array when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await loadInstalledPlugins()).toEqual([]);
  });

  it("returns empty array for malformed JSON", async () => {
    mockReadFile.mockResolvedValue("not-json");
    expect(await loadInstalledPlugins()).toEqual([]);
  });

  it("parses pluginName and marketplace from key@marketplace format", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "nextjs@anthropics/claude-plugins-official": [
            {
              installPath: "/fake/plugins/cache/anthropics/nextjs/1.0.0",
              version: "1.0.0",
              gitCommitSha: "abc1234",
            },
          ],
        });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result).toHaveLength(1);
    expect(result[0].pluginName).toBe("nextjs");
    expect(result[0].marketplace).toBe("anthropics/claude-plugins-official");
    expect(result[0].version).toBe("1.0.0");
    expect(result[0].gitCommitSha).toBe("abc1234");
  });

  it("handles scoped plugin names (multiple @ signs) by splitting on last @", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "@scope/plugin@some-marketplace": [
            { installPath: "/fake/plugins/cache/some-marketplace/@scope/plugin/0.1.0" },
          ],
        });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result[0].pluginName).toBe("@scope/plugin");
    expect(result[0].marketplace).toBe("some-marketplace");
  });

  it("reads pluginRepoUrl from plugin.json when present", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "vercel@vercel-marketplace": [
            { installPath: "/fake/plugins/vercel" },
          ],
        });
      }
      if (filePath.includes("plugin.json")) {
        return JSON.stringify({ repository: "https://github.com/vercel/vercel-skill" });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result[0].pluginRepoUrl).toBe("https://github.com/vercel/vercel-skill");
  });

  it("sets pluginRepoUrl to undefined when plugin.json is missing", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "myskill@my-marketplace": [{ installPath: "/fake/plugins/myskill" }],
        });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result[0].pluginRepoUrl).toBeUndefined();
  });

  it("skips entries with no installPath", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "noop@marketplace": [{ version: "1.0.0" }],
          "valid@marketplace": [{ installPath: "/fake/plugins/valid" }],
        });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result).toHaveLength(1);
    expect(result[0].pluginName).toBe("valid");
  });

  it("deduplicates entries with the same installPath", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.endsWith("installed_plugins.json")) {
        return makePluginsFile({
          "a@mp": [{ installPath: "/fake/shared" }],
          "b@mp": [{ installPath: "/fake/shared" }],
        });
      }
      throw NO_PLUGIN_JSON;
    });

    const result = await loadInstalledPlugins();
    expect(result).toHaveLength(1);
  });
});
