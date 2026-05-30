import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process so no real `claudelint format` subprocess runs.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

// Mock fs so before/after byte reads are controlled per test.
vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));

// Mock the backup layer — applyFormatting must snapshot BEFORE the fix and
// roll back snapshots for unchanged files. We assert on these calls rather
// than touching the real config-history manifest.
vi.mock("@/lib/configHistory", () => ({
  recordPreWrite: vi.fn().mockResolvedValue("backup-1"),
  removeBackup: vi.fn().mockResolvedValue(undefined),
}));

import { spawn } from "child_process";
import { promises as fs } from "fs";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { checkFormatting, applyFormatting } from "@/lib/lint/format";
import { recordPreWrite, removeBackup } from "@/lib/configHistory";

const mockSpawn = vi.mocked(spawn);
const mockReadFile = vi.mocked(fs.readFile);
const mockRecord = vi.mocked(recordPreWrite);
const mockRemove = vi.mocked(removeBackup);

// Emit lazily — only once the consumer attaches its `close` listener. The
// process objects are created up-front via mockReturnValueOnce, well before
// applyFormatting's second (--fix) spawn consumes them; eager emission would
// fire close before the listener exists and the await would hang.
function emitOnClose(proc: ChildProcess, fire: () => void): void {
  proc.once("newListener", (event) => {
    if (event === "close") queueMicrotask(fire);
  });
}

function makeFakeProcess(stdout: string, exitCode = 0): ChildProcess {
  const stdoutEmitter = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { stdout: EventEmitter }).stdout = stdoutEmitter;
  emitOnClose(proc, () => {
    stdoutEmitter.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });
  return proc;
}

function makeErroringProcess(message: string): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  // `error` is attached just after `close` in runFormatCli; the microtask
  // defers past both synchronous attaches, so the error listener is ready.
  emitOnClose(proc, () => proc.emit("error", new Error(message)));
  return proc;
}

const DRY_RUN_DIRTY = `
Formatting Claude files (dry-run mode)

Running markdownlint on Claude markdown files...
Markdownlint found issues in 1 file(s)

2 files checked, 0 formatted, 2 with errors

Files needing formatting:
    CLAUDE.md
    .claude/settings.json

Formatting check failed. Run without --check to auto-fix issues.
`;

const DRY_RUN_CLEAN = `
Formatting Claude files (dry-run mode)

Running markdownlint on Claude markdown files...
All files formatted correctly

2 files checked, 0 formatted, 0 with errors
`;

beforeEach(() => vi.clearAllMocks());

describe("checkFormatting", () => {
  it("parses the indented file list under the header", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(DRY_RUN_DIRTY, 1));
    const result = await checkFormatting("/project");
    expect(result.mode).toBe("check");
    expect(result.filesNeedingFormat).toEqual(["CLAUDE.md", ".claude/settings.json"]);
    expect(result.engineError).toBeUndefined();
  });

  it("returns an empty list when nothing needs formatting", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(DRY_RUN_CLEAN, 0));
    const result = await checkFormatting("/project");
    expect(result.filesNeedingFormat).toEqual([]);
  });

  it("records an engineError and empty list on spawn failure", async () => {
    mockSpawn.mockReturnValue(makeErroringProcess("ENOENT"));
    const result = await checkFormatting("/project");
    expect(result.filesNeedingFormat).toEqual([]);
    expect(result.engineError).toMatch(/ENOENT/);
  });

  it("runs in non-mutating dry-run mode", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(DRY_RUN_CLEAN, 0));
    await checkFormatting("/project");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("format");
    expect(args).toContain("--fix-dry-run");
    expect(args).not.toContain("--fix");
  });
});

describe("applyFormatting", () => {
  it("snapshots each file BEFORE the fix and reports the changed ones", async () => {
    // First spawn = dry-run discovery, second spawn = the mutating --fix.
    mockSpawn
      .mockReturnValueOnce(makeFakeProcess(DRY_RUN_DIRTY, 1))
      .mockReturnValueOnce(makeFakeProcess("2 files checked, 2 formatted, 0 with errors", 0));
    // before/after for CLAUDE.md (changed) then settings.json (changed).
    mockReadFile
      .mockResolvedValueOnce(Buffer.from("# old\n")) // CLAUDE.md before
      .mockResolvedValueOnce(Buffer.from("{}\n"))     // settings before
      .mockResolvedValueOnce(Buffer.from("# new\n")) // CLAUDE.md after
      .mockResolvedValueOnce(Buffer.from("{ }\n"));   // settings after

    const result = await applyFormatting("/project", { projectSlug: "proj" });

    expect(result.mode).toBe("apply");
    expect(mockRecord).toHaveBeenCalledTimes(2);
    // recordPreWrite happens before the second (fix) spawn.
    expect(result.formatted).toHaveLength(2);
    expect(result.formatted.every((f) => f.changed)).toBe(true);
    expect(result.formatted[0].backupId).toBe("backup-1");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("rolls back the snapshot for a file the formatter left unchanged", async () => {
    mockSpawn
      .mockReturnValueOnce(makeFakeProcess(
        "Files needing formatting:\n    CLAUDE.md\n",
        1,
      ))
      .mockReturnValueOnce(makeFakeProcess("done", 0));
    mockReadFile
      .mockResolvedValueOnce(Buffer.from("same\n")) // before
      .mockResolvedValueOnce(Buffer.from("same\n")); // after — identical

    const result = await applyFormatting("/project");

    expect(result.formatted).toEqual([
      { file: "CLAUDE.md", backupId: null, changed: false },
    ]);
    expect(mockRemove).toHaveBeenCalledWith("backup-1");
  });

  it("does not run the mutating fix when nothing needs formatting", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(DRY_RUN_CLEAN, 0));
    const result = await applyFormatting("/project");
    expect(result.formatted).toEqual([]);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // dry-run only, no --fix
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("propagates a dry-run engineError without mutating", async () => {
    mockSpawn.mockReturnValue(makeErroringProcess("spawn blew up"));
    const result = await applyFormatting("/project");
    expect(result.formatted).toEqual([]);
    expect(result.engineError).toMatch(/spawn blew up/);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
