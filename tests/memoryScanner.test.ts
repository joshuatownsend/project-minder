import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Stats } from "fs";

vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { scanMemory } from "@/lib/scanner/memory";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReaddir = vi.mocked(fs.readdir) as any;
const mockReadFile = vi.mocked(fs.readFile);
const mockStat = vi.mocked(fs.stat);

function makeStat(size = 256): Stats {
  return { mtime: new Date("2026-04-01T12:00:00Z"), size } as unknown as Stats;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear module-level cache between tests by re-importing won't work,
  // but we can work around it by using unique project paths per test.
});

describe("scanMemory", () => {
  it("returns empty when memory dir does not exist", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await scanMemory("C:\\dev\\missing-project");
    expect(result.files).toHaveLength(0);
    expect(result.indexMd).toBeUndefined();
  });

  it("captures MEMORY.md as indexMd and excludes it from files[]", async () => {
    mockReaddir.mockResolvedValueOnce(["MEMORY.md", "user_role.md"] );
    mockStat.mockResolvedValue(makeStat());
    mockReadFile
      .mockResolvedValueOnce("# Index\nsome content" as never) // MEMORY.md
      .mockResolvedValueOnce("---\nname: role\ntype: user\ndescription: User role\n---\nbody" as never);

    const result = await scanMemory("C:\\dev\\test-project-1");

    expect(result.indexMd).toContain("Index");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("user_role.md");
  });

  it("parses frontmatter type and description", async () => {
    mockReaddir.mockResolvedValueOnce(["feedback_testing.md"] );
    mockStat.mockResolvedValue(makeStat());
    mockReadFile.mockResolvedValueOnce(
      "---\nname: testing feedback\ntype: feedback\ndescription: Don't mock the DB\n---\ncontent" as never
    );

    const result = await scanMemory("C:\\dev\\test-project-2");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].type).toBe("feedback");
    expect(result.files[0].description).toBe("Don't mock the DB");
  });

  it("handles files without frontmatter gracefully", async () => {
    mockReaddir.mockResolvedValueOnce(["notes.md"] );
    mockStat.mockResolvedValue(makeStat());
    mockReadFile.mockResolvedValueOnce("Just some notes without frontmatter" as never);

    const result = await scanMemory("C:\\dev\\test-project-3");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].type).toBeUndefined();
    expect(result.files[0].description).toBeUndefined();
  });

  it("ignores non-.md files", async () => {
    mockReaddir.mockResolvedValueOnce(["notes.md", "notes.txt", "data.json"] );
    mockStat.mockResolvedValue(makeStat());
    mockReadFile.mockResolvedValueOnce("content" as never);

    const result = await scanMemory("C:\\dev\\test-project-4");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("notes.md");
  });

  it("sorts files by mtime descending", async () => {
    mockReaddir.mockResolvedValueOnce(["old.md", "new.md"] );
    mockStat
      .mockResolvedValueOnce({ mtime: new Date("2026-01-01"), size: 100 } as unknown as Stats)
      .mockResolvedValueOnce({ mtime: new Date("2026-04-01"), size: 100 } as unknown as Stats);
    mockReadFile
      .mockResolvedValueOnce("old content" as never)
      .mockResolvedValueOnce("new content" as never);

    const result = await scanMemory("C:\\dev\\test-project-5");

    expect(result.files[0].name).toBe("new.md");
    expect(result.files[1].name).toBe("old.md");
  });
});
