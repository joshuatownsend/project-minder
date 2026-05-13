import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { scanOutputStyles } from "@/lib/scanner/outputStyles";

const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("scanOutputStyles", () => {
  it("returns undefined when .claude/output-styles does not exist", async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await scanOutputStyles("/proj")).toBeUndefined();
  });

  it("returns undefined when output-styles directory has no subdirectories", async () => {
    mockReaddir.mockResolvedValueOnce([]);
    expect(await scanOutputStyles("/proj")).toBeUndefined();
  });

  it("returns undefined when subdirs exist but have no .md files", async () => {
    mockReaddir
      .mockResolvedValueOnce([{ name: "concise", isDirectory: () => true }] as never)
      .mockResolvedValueOnce(["config.json"] as never);
    expect(await scanOutputStyles("/proj")).toBeUndefined();
  });

  it("returns OutputStylesInfo with parsed frontmatter for a valid style", async () => {
    mockReaddir
      .mockResolvedValueOnce([{ name: "concise", isDirectory: () => true }] as never)
      .mockResolvedValueOnce(["PROMPT.md"] as never);
    mockReadFile.mockResolvedValueOnce("---\ntitle: Concise\n---\nBe terse." as never);

    const result = await scanOutputStyles("/proj");
    expect(result).not.toBeUndefined();
    expect(result!.styles).toHaveLength(1);
    expect(result!.styles[0].name).toBe("concise");
    expect(result!.styles[0].frontmatter).toMatchObject({ title: "Concise" });
    expect(result!.styles[0].promptPath).toContain("PROMPT.md");
  });

  it("returns multiple styles when multiple subdirectories exist", async () => {
    mockReaddir
      .mockResolvedValueOnce([
        { name: "verbose", isDirectory: () => true },
        { name: "technical", isDirectory: () => true },
      ] as never)
      .mockResolvedValueOnce(["PROMPT.md"] as never)
      .mockResolvedValueOnce(["PROMPT.md"] as never);
    mockReadFile
      .mockResolvedValueOnce("---\ntitle: Verbose\n---\nBe detailed." as never)
      .mockResolvedValueOnce("---\ntitle: Technical\n---\nUse jargon." as never);

    const result = await scanOutputStyles("/proj");
    expect(result!.styles).toHaveLength(2);
    expect(result!.styles.map((s) => s.name)).toEqual(["verbose", "technical"]);
  });

  it("skips a style subdirectory that throws on readdir", async () => {
    mockReaddir
      .mockResolvedValueOnce([{ name: "broken", isDirectory: () => true }] as never)
      .mockRejectedValueOnce(new Error("EACCES"));
    expect(await scanOutputStyles("/proj")).toBeUndefined();
  });

  it("ignores non-directory entries in the output-styles directory", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: "README.md", isDirectory: () => false },
    ] as never);
    expect(await scanOutputStyles("/proj")).toBeUndefined();
  });
});
