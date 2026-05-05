import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    access: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { countProjectCatalog } from "@/lib/scanner/projectCatalogCounts";

const mockReaddir = vi.mocked(fs.readdir);
const mockAccess = vi.mocked(fs.access);

beforeEach(() => vi.clearAllMocks());

function makeEntry(name: string, type: "file" | "directory" | "symlink") {
  return {
    name,
    isFile: () => type === "file",
    isDirectory: () => type === "directory",
    isSymbolicLink: () => type === "symlink",
  };
}

describe("countProjectCatalog", () => {
  it("returns zeros when .claude dirs do not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await countProjectCatalog("/fake/project");
    expect(result).toEqual({ agentCount: 0, skillCount: 0 });
  });

  it("counts .md files in .claude/agents", async () => {
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith(path.join(".claude", "agents"))) {
        return [
          makeEntry("agent1.md", "file"),
          makeEntry("agent2.md", "file"),
          makeEntry("agent.tmpl", "file"),
          makeEntry("notes.txt", "file"),
        ] as any;
      }
      throw new Error("ENOENT");
    });

    const result = await countProjectCatalog("/fake/project");
    expect(result.agentCount).toBe(2);
    expect(result.skillCount).toBe(0);
  });

  it("counts standalone .md files in .claude/skills", async () => {
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith(path.join(".claude", "skills"))) {
        return [
          makeEntry("skill1.md", "file"),
          makeEntry("skill2.md", "file"),
        ] as any;
      }
      throw new Error("ENOENT");
    });

    const result = await countProjectCatalog("/fake/project");
    expect(result.agentCount).toBe(0);
    expect(result.skillCount).toBe(2);
  });

  it("counts bundled skills (dirs with SKILL.md)", async () => {
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith(path.join(".claude", "skills"))) {
        return [
          makeEntry("my-skill", "directory"),
          makeEntry("other-skill", "directory"),
          makeEntry("empty-dir", "directory"),
        ] as any;
      }
      throw new Error("ENOENT");
    });

    mockAccess.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      if (filePath.includes("empty-dir")) throw new Error("ENOENT");
      // my-skill and other-skill have SKILL.md
    });

    const result = await countProjectCatalog("/fake/project");
    expect(result.skillCount).toBe(2);
  });

  it("skips .tmpl files in agents dir", async () => {
    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith(path.join(".claude", "agents"))) {
        return [makeEntry("agent.tmpl", "file")] as any;
      }
      throw new Error("ENOENT");
    });

    const result = await countProjectCatalog("/fake/project");
    expect(result.agentCount).toBe(0);
  });
});
