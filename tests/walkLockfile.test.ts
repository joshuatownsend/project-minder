import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { loadLockfile } from "@/lib/indexer/walkLockfile";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

const VALID_ENTRY = {
  source: "clerk/skills",
  sourceType: "github",
  sourceUrl: "https://github.com/clerk/skills.git",
  skillPath: "skills/clerk/SKILL.md",
  skillFolderHash: "abc123",
  installedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-03-01T00:00:00Z",
};

describe("loadLockfile", () => {
  it("returns empty Map when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await loadLockfile();
    expect(result.size).toBe(0);
  });

  it("returns empty Map for malformed JSON", async () => {
    mockReadFile.mockResolvedValue("not-json");
    const result = await loadLockfile();
    expect(result.size).toBe(0);
  });

  it("returns empty Map when skills key is absent", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));
    const result = await loadLockfile();
    expect(result.size).toBe(0);
  });

  it("parses a valid lockfile entry", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, skills: { clerk: VALID_ENTRY } })
    );
    const result = await loadLockfile();
    expect(result.size).toBe(1);
    const entry = result.get("clerk");
    expect(entry?.sourceUrl).toBe("https://github.com/clerk/skills.git");
    expect(entry?.skillFolderHash).toBe("abc123");
    expect(entry?.installedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("parses multiple entries", async () => {
    const skills = {
      clerk: VALID_ENTRY,
      vercel: { ...VALID_ENTRY, sourceUrl: "https://github.com/vercel/skills.git" },
    };
    mockReadFile.mockResolvedValue(JSON.stringify({ skills }));
    const result = await loadLockfile();
    expect(result.size).toBe(2);
    expect(result.has("clerk")).toBe(true);
    expect(result.has("vercel")).toBe(true);
  });

  it("skips entries that have no sourceUrl string", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        skills: {
          valid: VALID_ENTRY,
          missing: { ...VALID_ENTRY, sourceUrl: 42 },
          empty: {},
        },
      })
    );
    const result = await loadLockfile();
    expect(result.size).toBe(1);
    expect(result.has("valid")).toBe(true);
  });
});
