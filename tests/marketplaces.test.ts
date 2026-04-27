import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { loadKnownMarketplaces } from "@/lib/indexer/marketplaces";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("loadKnownMarketplaces", () => {
  it("returns empty Map when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await loadKnownMarketplaces();
    expect(result.size).toBe(0);
  });

  it("returns empty Map for malformed JSON", async () => {
    mockReadFile.mockResolvedValue("not-json");
    const result = await loadKnownMarketplaces();
    expect(result.size).toBe(0);
  });

  it("parses a marketplace entry with a source.repo field", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        "anthropics/claude-plugins-official": {
          source: { repo: "anthropics/claude-plugins-official" },
          installLocation: "/fake/marketplaces/anthropics",
          lastUpdated: "2026-01-01T00:00:00Z",
        },
      })
    );
    const result = await loadKnownMarketplaces();
    expect(result.size).toBe(1);
    expect(result.get("anthropics/claude-plugins-official")).toBe(
      "anthropics/claude-plugins-official"
    );
  });

  it("parses multiple marketplace entries", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        "mp-one": { source: { repo: "owner/repo-one" } },
        "mp-two": { source: { repo: "owner/repo-two" } },
      })
    );
    const result = await loadKnownMarketplaces();
    expect(result.size).toBe(2);
    expect(result.get("mp-one")).toBe("owner/repo-one");
    expect(result.get("mp-two")).toBe("owner/repo-two");
  });

  it("skips entries without a source.repo field", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        "has-repo": { source: { repo: "owner/repo" } },
        "no-source": { installLocation: "/fake/path" },
        "no-repo": { source: {} },
      })
    );
    const result = await loadKnownMarketplaces();
    expect(result.size).toBe(1);
    expect(result.has("has-repo")).toBe(true);
  });
});
