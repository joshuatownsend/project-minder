import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("@/lib/configHistory", () => ({
  recordPreWrite: vi.fn().mockResolvedValue("backup-test-id"),
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\test" },
  homedir: () => "C:\\Users\\test",
}));

import { promises as fs } from "fs";
import { writeMemoryFile } from "@/lib/scanner/memoryWriter";
import { recordPreWrite } from "@/lib/configHistory";

const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockRename = vi.mocked(fs.rename);
const mockUnlink = vi.mocked(fs.unlink);
const mockStat = vi.mocked(fs.stat);
const mockRecordPreWrite = vi.mocked(recordPreWrite);

const DEFAULT_STAT = { mtimeMs: 5000, size: 100 } as Awaited<ReturnType<typeof fs.stat>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined as never);
  mockMkdir.mockResolvedValue(undefined as never);
  mockRename.mockResolvedValue(undefined as never);
  mockUnlink.mockResolvedValue(undefined as never);
  // Default: file exists with a stable mtime; used by the post-write stat.
  mockStat.mockResolvedValue(DEFAULT_STAT);
  mockRecordPreWrite.mockResolvedValue("backup-test-id" as never);
});

describe("writeMemoryFile", () => {
  it("writes a valid .md file (atomic write + rename)", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "# hi");
    expect(r.ok).toBe(true);
    expect(r.bytesWritten).toBeGreaterThan(0);
    // writeFileAtomic writes to a tmp file then renames into place.
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledTimes(1);
    const renameTarget = String(mockRename.mock.calls[0][1]);
    expect(renameTarget).toContain("memory");
    expect(renameTarget.endsWith("notes.md")).toBe(true);
  });

  it("rejects path traversal via slash", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "../escape.md", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TRAVERSAL");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects path traversal via backslash", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "..\\evil.md", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TRAVERSAL");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects non-.md files", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.txt", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_MARKDOWN");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects empty filename", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_NAME");
  });

  it("rejects null bytes", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "evil\0.md", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TRAVERSAL");
  });

  it("creates the memory dir lazily", async () => {
    await writeMemoryFile("C:\\dev\\new-proj", "notes.md", "hi");
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(String(mockMkdir.mock.calls[0][0])).toContain("memory");
  });

  it("surfaces filesystem failures with WRITE_FAILED", async () => {
    mockRename.mockRejectedValueOnce(new Error("EACCES"));
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("WRITE_FAILED");
    expect((r.error as { code: "WRITE_FAILED"; message: string }).message).toContain("EACCES");
  });

  it("rejects prefix/type mismatch in frontmatter (M.3 typed authoring)", async () => {
    const content = "---\ntype: reference\n---\n\nbody";
    const r = await writeMemoryFile("C:\\dev\\myproj", "feedback_x.md", content);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("FRONTMATTER_INVALID");
  });

  it("rejects unknown prefix when frontmatter declares a type", async () => {
    const content = "---\ntype: user\n---\n\nbody";
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", content);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("FRONTMATTER_INVALID");
  });

  it("accepts a well-typed memory file with matching prefix + type", async () => {
    const content = "---\ntype: user\nname: u\n---\n\nbody";
    const r = await writeMemoryFile("C:\\dev\\myproj", "user_role.md", content);
    expect(r.ok).toBe(true);
  });

  it("tolerates untyped scratch files with no frontmatter (back-compat)", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "plain body");
    expect(r.ok).toBe(true);
  });

  it("respects skipTypeValidation for callers that opt out", async () => {
    const content = "---\ntype: reference\n---\n\nbody";
    const r = await writeMemoryFile(
      "C:\\dev\\myproj",
      "feedback_x.md",
      content,
      { skipTypeValidation: true },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects content exceeding MAX_BYTES with TOO_LARGE", async () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", huge);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TOO_LARGE");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("succeeds with expectedMtimeMs matching current stat", async () => {
    mockStat.mockResolvedValue({ mtimeMs: 1234, size: 50 } as Awaited<ReturnType<typeof fs.stat>>);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body", {
      expectedMtimeMs: 1234,
    });
    expect(r.ok).toBe(true);
    expect(r.mtimeMs).toBe(1234);
    expect(r.sizeBytes).toBe(50);
  });

  it("returns MTIME_CONFLICT when expectedMtimeMs differs by more than 1ms", async () => {
    mockStat.mockResolvedValue({ mtimeMs: 9999, size: 50 } as Awaited<ReturnType<typeof fs.stat>>);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body", {
      expectedMtimeMs: 1234,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("MTIME_CONFLICT");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("succeeds with expectedMtimeMs: 0 when file does not exist (first write)", async () => {
    // stat throws ENOENT before the write; succeeds after the write
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockStat
      .mockRejectedValueOnce(enoent)
      .mockResolvedValue({ mtimeMs: 2000, size: 20 } as Awaited<ReturnType<typeof fs.stat>>);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body", {
      expectedMtimeMs: 0,
    });
    expect(r.ok).toBe(true);
  });

  it("returns MTIME_CONFLICT when expectedMtimeMs is non-zero but file is missing", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockStat.mockRejectedValueOnce(enoent);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body", {
      expectedMtimeMs: 5555,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("MTIME_CONFLICT");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("surfaces WRITE_FAILED when stat throws a non-ENOENT error during mtime check", async () => {
    const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    mockStat.mockRejectedValueOnce(eperm);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body", {
      expectedMtimeMs: 5555,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("WRITE_FAILED");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("populates backupId from recordPreWrite on success", async () => {
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body");
    expect(r.ok).toBe(true);
    expect(r.backupId).toBe("backup-test-id");
    expect(mockRecordPreWrite).toHaveBeenCalledTimes(1);
  });

  it("proceeds with null backupId when recordPreWrite throws", async () => {
    mockRecordPreWrite.mockRejectedValueOnce(new Error("disk full"));
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body");
    expect(r.ok).toBe(true);
    expect(r.backupId).toBeNull();
    // Underlying write still happened
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  it("returns mtimeMs and sizeBytes from post-write stat", async () => {
    mockStat.mockResolvedValue({ mtimeMs: 7777, size: 42 } as Awaited<ReturnType<typeof fs.stat>>);
    const r = await writeMemoryFile("C:\\dev\\myproj", "notes.md", "body");
    expect(r.ok).toBe(true);
    expect(r.mtimeMs).toBe(7777);
    expect(r.sizeBytes).toBe(42);
  });
});
