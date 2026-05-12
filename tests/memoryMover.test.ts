import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  archiveMemoryFile,
  softDeleteMemoryFile,
  restoreFromSubdir,
  listArchivedMemoryFiles,
  listTrashedMemoryFiles,
  sweepTrash,
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
});

describe("restoreFromSubdir", () => {
  it("restores an archived file back to the memory dir", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const r = await restoreFromSubdir(PROJECT, "stale.md", ARCHIVE_SUBDIR);
    expect(r.ok).toBe(true);
    const memDir = memoryDirFor(PROJECT);
    await expect(fs.access(path.join(memDir, "stale.md"))).resolves.toBeUndefined();
    const archived = await listArchivedMemoryFiles(PROJECT);
    expect(archived).toHaveLength(0);
  });

  it("restores a trashed file back to the memory dir", async () => {
    await softDeleteMemoryFile(PROJECT, "stale.md");
    const r = await restoreFromSubdir(PROJECT, "stale.md", TRASH_SUBDIR);
    expect(r.ok).toBe(true);
    const trashed = await listTrashedMemoryFiles(PROJECT);
    expect(trashed).toHaveLength(0);
  });

  it("suffixes the restored copy when the parent now has the same name", async () => {
    await archiveMemoryFile(PROJECT, "stale.md");
    const memDir = memoryDirFor(PROJECT);
    // Recreate a file with that name in the live dir.
    await fs.writeFile(path.join(memDir, "stale.md"), "# new\n", "utf-8");
    const r = await restoreFromSubdir(PROJECT, "stale.md", ARCHIVE_SUBDIR);
    expect(r.ok).toBe(true);
    expect(r.destPath).toMatch(/stale-\d{14}\.md$/);
  });

  it("returns SOURCE_NOT_FOUND when restoring a file that isn't in the subdir", async () => {
    const r = await restoreFromSubdir(PROJECT, "never-archived.md", ARCHIVE_SUBDIR);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SOURCE_NOT_FOUND");
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
