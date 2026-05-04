import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\test" },
  homedir: () => "C:\\Users\\test",
}));

import { promises as fs } from "fs";
import { writeMemoryFile } from "@/lib/scanner/memoryWriter";

const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockRename = vi.mocked(fs.rename);
const mockUnlink = vi.mocked(fs.unlink);

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined as never);
  mockMkdir.mockResolvedValue(undefined as never);
  mockRename.mockResolvedValue(undefined as never);
  mockUnlink.mockResolvedValue(undefined as never);
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
});
