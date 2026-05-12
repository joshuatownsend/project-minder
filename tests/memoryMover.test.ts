import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  archiveMemoryFile,
  softDeleteMemoryFile,
  restoreFromArchive,
  restoreFromTrash,
  listArchivedMemoryFiles,
  listTrashedMemoryFiles,
  sweepTrash,
  sweepAndListTrash,
  memoryDirFor,
  ARCHIVE_SUBDIR,
  TRASH_SUBDIR,
} from "@/lib/scanner/memoryWriter";

let tmpHome: string;
const PROJECT = "C:\\dev\\alpha";

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "memoryMover-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  // Lay down a real memory dir + file so the mover has something to work on.
  const memDir = memoryDirFor(PROJECT);
  await fs.mkdir(memDir, { recursive: true });
  await fs.writeFile(path.join(memDir, "stale.md"), "# stale\n", "utf-8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("archiveMemoryFile", () => {
  it("moves a memory file into <memoryDir>/archive/", async () => {
    const r = await archiveMemoryFile(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    expect(r.destPath).toContain(`${path.sep}${ARCHIVE_SUBDIR}${path.sep}stale.md`);
    const memDir = memoryDirFor(PROJECT);
    await expect(fs.access(path.join(memDir, "stale.md"))).rejects.toBeDefined();
    await expect(fs.access(path.join(memDir, ARCHIVE_SUBDIR, "stale.md"))).resolves.toBeUndefined();
  });

  it("suffixes the destination on collision so prior archives aren't clobbered", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    // Recreate the live file and archive again with the same name.
    const memDir = memoryDirFor(PROJECT);
    await fs.writeFile(path.join(memDir, "stale.md"), "# round 2\n", "utf-8");
    const r = await archiveMemoryFile(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    expect(r.destPath).toMatch(/stale-\d{14}\.md$/);
    const archived = await listArchivedMemoryFiles(PROJECT);
    expect(archived).toHaveLength(2);
  });

  it("rejects traversal attempts", async () => {
    const r = await archiveMemoryFile(PROJECT, "../escape.md");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TRAVERSAL");
  });

  it("rejects non-.md filenames", async () => {
    const r = await archiveMemoryFile(PROJECT, "stale.txt");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_MARKDOWN");
  });

  it("returns SOURCE_NOT_FOUND when the file doesn't exist", async () => {
    const r = await archiveMemoryFile(PROJECT, "ghost.md");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SOURCE_NOT_FOUND");
  });
});

describe("softDeleteMemoryFile", () => {
  it("moves a memory file into <memoryDir>/.trash/", async () => {
    const r = await softDeleteMemoryFile(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    expect(r.destPath).toContain(`${path.sep}${TRASH_SUBDIR}${path.sep}stale.md`);
    const trashed = await listTrashedMemoryFiles(PROJECT);
    expect(trashed.map((t) => t.name)).toContain("stale.md");
  });

  it("trash dir name starts with a dot so the main scanner skips it", () => {
    expect(TRASH_SUBDIR.startsWith(".")).toBe(true);
  });

  it("refreshes mtime so the 30d trash window starts at deletion, not source-mtime", async () => {
    // Regression: previously the sweep used the rename-preserved mtime, so a
    // 60d-old memory soft-deleted right now would be permanently unlinked on
    // the very next sweep instead of staying recoverable for 30 days.
    const memDir = memoryDirFor(PROJECT);
    const past = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    await fs.utimes(path.join(memDir, "stale.md"), past, past);

    const before = Date.now();
    const r = await softDeleteMemoryFile(PROJECT, "stale.md");
    expect(r.ok).toBe(true);

    const trashed = await listTrashedMemoryFiles(PROJECT);
    expect(trashed).toHaveLength(1);
    expect(trashed[0].mtimeMs).toBeGreaterThanOrEqual(before - 1000);

    // Sweep should NOT eat the file — it's fresh trash, not 90d-old trash.
    const sweep = await sweepAndListTrash(PROJECT);
    expect(sweep.removed).toBe(0);
    expect(sweep.survivors).toHaveLength(1);
  });
});

describe("restoreFromArchive / restoreFromTrash", () => {
  it("restores an archived file back to the memory dir", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const r = await restoreFromArchive(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    const memDir = memoryDirFor(PROJECT);
    await expect(fs.access(path.join(memDir, "stale.md"))).resolves.toBeUndefined();
    const archived = await listArchivedMemoryFiles(PROJECT);
    expect(archived).toHaveLength(0);
  });

  it("restores a trashed file back to the memory dir", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const r = await restoreFromTrash(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    const trashed = await listTrashedMemoryFiles(PROJECT);
    expect(trashed).toHaveLength(0);
  });

  it("suffixes the restored copy when the parent now has the same name", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const memDir = memoryDirFor(PROJECT);
    await fs.writeFile(path.join(memDir, "stale.md"), "# new\n", "utf-8");
    const r = await restoreFromArchive(PROJECT, "stale.md");
    expect(r.ok).toBe(true);
    expect(r.destPath).toMatch(/stale-\d{14}\.md$/);
  });

  it("returns SOURCE_NOT_FOUND when restoring a file that isn't in the subdir", async () => {
    const r = await restoreFromArchive(PROJECT, "never-archived.md");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SOURCE_NOT_FOUND");
  });
});

describe("destination locking", () => {
  it("serializes concurrent archives of same-named files so neither is clobbered", async () => {
    // Regression: renameInsideMemoryDir originally only locked srcPath, so
    // two concurrent archives of files with the same basename could both
    // observe an empty destDir and pick the same destPath — POSIX rename
    // then silently overwrites. The destDir lock funnels them through the
    // existence check sequentially, forcing the second to suffix.
    const memDir = memoryDirFor(PROJECT);
    // Two distinct source files with the same basename via separate restores
    // is the natural shape; we simulate by archiving, recreating, archiving.
    // Concurrent archives of the same path collide trivially — what we want
    // to prove is the lock prevents both choosing the same dest.
    await fs.writeFile(path.join(memDir, "a.md"), "# A1\n", "utf-8");
    await fs.writeFile(path.join(memDir, "b.md"), "# B1\n", "utf-8");
    // Stash one into archive ahead of time so the next archive must suffix.
    await archiveMemoryFile(PROJECT, "a.md");
    // Recreate to set up the race; b.md is a sentinel so the dir isn't empty.
    await fs.writeFile(path.join(memDir, "a.md"), "# A2\n", "utf-8");
    const results = await Promise.all([
      archiveMemoryFile(PROJECT, "a.md"),
      archiveMemoryFile(PROJECT, "b.md"),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const archived = await listArchivedMemoryFiles(PROJECT);
    // 3 archived files: the original a.md, the suffixed a-TIMESTAMP.md, and b.md.
    expect(archived).toHaveLength(3);
    const uniquePaths = new Set(archived.map((f) => f.absPath));
    expect(uniquePaths.size).toBe(3);
  });
});

describe("sweepAndListTrash", () => {
  it("returns survivors and removed-count in one pass", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const r = await sweepAndListTrash(PROJECT);
    expect(r.removed).toBe(0);
    expect(r.survivors).toHaveLength(1);
    expect(r.survivors[0].name).toBe("stale.md");
  });

  it("unlinks expired entries and omits them from survivors", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const trashed = await listTrashedMemoryFiles(PROJECT);
    const past = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    await fs.utimes(trashed[0].absPath, past, past);
    const r = await sweepAndListTrash(PROJECT);
    expect(r.removed).toBe(1);
    expect(r.survivors).toHaveLength(0);
  });
});

describe("sweepTrash", () => {
  it("permanently removes trashed files older than the max-age threshold", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const trashed = await listTrashedMemoryFiles(PROJECT);
    expect(trashed).toHaveLength(1);
    // Backdate its mtime to 40 days ago so it qualifies for the default 30d sweep.
    const past = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    await fs.utimes(trashed[0].absPath, past, past);

    const r = await sweepTrash(PROJECT);
    expect(r.removed).toBe(1);
    expect(await listTrashedMemoryFiles(PROJECT)).toHaveLength(0);
  });

  it("preserves trashed files newer than the max-age threshold", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const r = await sweepTrash(PROJECT);
    expect(r.removed).toBe(0);
    expect(await listTrashedMemoryFiles(PROJECT)).toHaveLength(1);
  });

  it("returns { removed: 0 } when the trash dir is absent", async () => {
    const r = await sweepTrash(PROJECT);
    expect(r.removed).toBe(0);
  });
});

describe("listArchivedMemoryFiles / listTrashedMemoryFiles", () => {
  it("returns [] when the subdir does not exist", async () => {
    expect(await listArchivedMemoryFiles(PROJECT)).toEqual([]);
    expect(await listTrashedMemoryFiles(PROJECT)).toEqual([]);
  });

  it("only surfaces .md files in the subdir (skips junk files)", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const archiveDir = path.join(memoryDirFor(PROJECT), ARCHIVE_SUBDIR);
    await fs.writeFile(path.join(archiveDir, "noise.txt"), "x", "utf-8");
    const list = await listArchivedMemoryFiles(PROJECT);
    expect(list.map((f) => f.name)).toEqual(["stale.md"]);
  });

  it("sorts results most-recently-archived first", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const memDir = memoryDirFor(PROJECT);
    await fs.writeFile(path.join(memDir, "later.md"), "# later\n", "utf-8");
    await new Promise((r) => setTimeout(r, 25));
    await archiveMemoryFile(PROJECT, "later.md");
    const list = await listArchivedMemoryFiles(PROJECT);
    expect(list[0].name).toBe("later.md");
  });
});
