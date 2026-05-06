import { describe, it, expect, vi, afterEach } from "vitest";
import path from "path";
import os from "os";
import type { Dirent, Stats } from "fs";

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    },
  };
});

const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");

async function freshScanner() {
  vi.resetModules();
  return import("@/lib/scanner/claudePlans");
}

function dirent(name: string): Dirent {
  return { isFile: () => true, isDirectory: () => false, name } as unknown as Dirent;
}

function stat(mtime = new Date("2026-05-01T10:00:00Z"), size = 100): Stats {
  return { mtime, size } as unknown as Stats;
}

afterEach(() => vi.clearAllMocks());

describe("scanClaudePlans", () => {
  it("returns empty array when plans dir does not exist", async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const { scanClaudePlans } = await freshScanner();
    expect(await scanClaudePlans()).toEqual([]);
  });

  it("returns empty array when plans dir is empty", async () => {
    mockReaddir.mockResolvedValue([]);
    const { scanClaudePlans } = await freshScanner();
    expect(await scanClaudePlans()).toEqual([]);
  });

  it("parses a plan file with front-matter title and tags", async () => {
    const raw = `---\ntitle: My Great Plan\ntags:\n  - wave5\n  - auth\n---\n\nBody text here.`;
    mockReaddir.mockResolvedValue([dirent("my-great-plan.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat(new Date("2026-05-01T10:00:00Z"), raw.length));

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();

    expect(results).toHaveLength(1);
    const p = results[0];
    expect(p.slug).toBe("my-great-plan");
    expect(p.title).toBe("My Great Plan");
    expect(p.tags).toEqual(["wave5", "auth"]);
    expect(p.relatedSessionIds).toEqual([]);
    expect(p.path).toBe(path.join(PLANS_DIR, "my-great-plan.md"));
    expect(p.mtime).toBe("2026-05-01T10:00:00.000Z");
  });

  it("falls back to first # heading when no front-matter title", async () => {
    const raw = `# Implementation Plan\n\nSome details here.`;
    mockReaddir.mockResolvedValue([dirent("impl-plan.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results[0].title).toBe("Implementation Plan");
    expect(results[0].tags).toEqual([]);
  });

  it("uses slug as title when no front-matter and no heading", async () => {
    const raw = `Just some prose without a heading.`;
    mockReaddir.mockResolvedValue([dirent("some-plan-slug.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results[0].title).toBe("some-plan-slug");
  });

  it("extracts related session UUIDs from the body", async () => {
    const uuid1 = "4bb141a4-1a4c-4794-a32a-b6bb351076ba";
    const uuid2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const raw = `# Plan\n\nSee session ${uuid1} for context.\nAlso ${uuid2}.`;
    mockReaddir.mockResolvedValue([dirent("plan.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results[0].relatedSessionIds).toContain(uuid1);
    expect(results[0].relatedSessionIds).toContain(uuid2);
  });

  it("deduplicates the same UUID appearing multiple times", async () => {
    const uuid = "4bb141a4-1a4c-4794-a32a-b6bb351076ba";
    const raw = `# Plan\n\nSession ${uuid} is mentioned here.\nAnd again: ${uuid}.`;
    mockReaddir.mockResolvedValue([dirent("plan.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results[0].relatedSessionIds).toHaveLength(1);
    expect(results[0].relatedSessionIds[0]).toBe(uuid);
  });

  it("skips non-.md files", async () => {
    mockReaddir.mockResolvedValue([dirent("notes.txt"), dirent("image.png")]);
    const { scanClaudePlans } = await freshScanner();
    expect(await scanClaudePlans()).toHaveLength(0);
  });

  it("skips a file that fails to read and continues (fails open)", async () => {
    mockReaddir.mockResolvedValue([dirent("good.md"), dirent("bad.md")]);
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith("bad.md")) throw new Error("EACCES");
      return "# Good Plan\n\nContent.";
    });
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("good");
  });

  it("normalizes UUIDs to lowercase", async () => {
    const uuid = "4BB141A4-1A4C-4794-A32A-B6BB351076BA";
    const raw = `# Plan\n\nSee ${uuid}.`;
    mockReaddir.mockResolvedValue([dirent("plan.md")]);
    mockReadFile.mockResolvedValue(raw);
    mockStat.mockResolvedValue(stat());

    const { scanClaudePlans } = await freshScanner();
    const results = await scanClaudePlans();
    expect(results[0].relatedSessionIds[0]).toBe(uuid.toLowerCase());
  });
});
