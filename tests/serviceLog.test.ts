import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock `fs` at module level (house pattern). serviceLog imports `* as fs`,
// so the mock must expose the exact functions it touches.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  renameSync: vi.fn(),
}));

import * as fs from "fs";
import {
  serviceLog,
  initServiceLog,
  isServiceLogActive,
  _resetServiceLogForTesting,
  shouldRotate,
  rotateLogs,
  MAX_BYTES,
  MAX_FILES,
  LOG_FILE,
} from "@/lib/serviceLog";

const mkdirSync = vi.mocked(fs.mkdirSync);
const statSync = vi.mocked(fs.statSync);
const appendFileSync = vi.mocked(fs.appendFileSync);
const existsSync = vi.mocked(fs.existsSync);
const rmSync = vi.mocked(fs.rmSync);
const renameSync = vi.mocked(fs.renameSync);

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  _resetServiceLogForTesting();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("shouldRotate (pure rotation math)", () => {
  it("never rotates an empty/missing file (currentBytes = 0)", () => {
    expect(shouldRotate(0, MAX_BYTES + 999, MAX_BYTES)).toBe(false);
  });

  it("does not rotate when the write stays within the cap", () => {
    expect(shouldRotate(MAX_BYTES - 100, 50, MAX_BYTES)).toBe(false);
  });

  it("rotates when the write would cross the cap", () => {
    expect(shouldRotate(MAX_BYTES - 100, 101, MAX_BYTES)).toBe(true);
  });

  it("rotates when already at the cap and any byte is added", () => {
    expect(shouldRotate(MAX_BYTES, 1, MAX_BYTES)).toBe(true);
  });

  it("defaults to the 5 MB cap", () => {
    expect(shouldRotate(MAX_BYTES, 1)).toBe(true);
    expect(MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("rotateLogs (ring rename order)", () => {
  it("drops the oldest then shifts .2→.3, .1→.2, log→.1 in that order", () => {
    existsSync.mockReturnValue(true);
    rotateLogs(LOG_FILE, MAX_FILES);

    // Oldest dropped first.
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith(`${LOG_FILE}.${MAX_FILES}`, { force: true });

    // Renames happen oldest→newest so no file clobbers a not-yet-moved one.
    const renamePairs = renameSync.mock.calls.map((c) => [c[0], c[1]]);
    expect(renamePairs).toEqual([
      [`${LOG_FILE}.2`, `${LOG_FILE}.3`],
      [`${LOG_FILE}.1`, `${LOG_FILE}.2`],
      [LOG_FILE, `${LOG_FILE}.1`],
    ]);
  });

  it("skips missing files without throwing", () => {
    existsSync.mockReturnValue(false);
    expect(() => rotateLogs(LOG_FILE, MAX_FILES)).not.toThrow();
    expect(rmSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });
});

describe("serviceLog activation gating", () => {
  it("tees to console but writes NO file before initServiceLog()", () => {
    expect(isServiceLogActive()).toBe(false);
    serviceLog({ msg: "hello" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("appends a JSON line to the log file once active", () => {
    initServiceLog();
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    statSync.mockReturnValue({ size: 10 } as unknown as ReturnType<typeof fs.statSync>);

    serviceLog({ level: "info", subsystem: "test", msg: "wrote" });

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const [file, payload] = appendFileSync.mock.calls[0];
    expect(file).toBe(LOG_FILE);
    const line = String(payload).trimEnd();
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe("wrote");
    expect(parsed.subsystem).toBe("test");
    expect(parsed.ts).toEqual(expect.any(String));
  });

  it("rotates before appending when the file is at the cap", () => {
    // Mock BEFORE init — the live size is seeded once by initServiceLog()
    // and tracked in memory afterward (no per-write statSync).
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ size: MAX_BYTES } as unknown as ReturnType<typeof fs.statSync>);
    initServiceLog();

    serviceLog({ msg: "big" });

    // Rotation ran (oldest dropped) before the append.
    expect(rmSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();
    expect(appendFileSync).toHaveBeenCalledTimes(1);
  });

  it("does NOT rotate a small file", () => {
    statSync.mockReturnValue({ size: 100 } as unknown as ReturnType<typeof fs.statSync>);
    initServiceLog();
    serviceLog({ msg: "small" });
    expect(renameSync).not.toHaveBeenCalled();
    expect(appendFileSync).toHaveBeenCalledTimes(1);
  });

  it("routes warn/error levels to console.warn", () => {
    serviceLog({ level: "warn", msg: "careful" });
    serviceLog({ level: "error", msg: "boom" });
    serviceLog({ level: "info", msg: "fine" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the fs append fails", () => {
    initServiceLog();
    statSync.mockReturnValue({ size: 1 } as unknown as ReturnType<typeof fs.statSync>);
    appendFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => serviceLog({ msg: "resilient" })).not.toThrow();
  });

  it("survives a circular field with a fallback line instead of throwing", () => {
    initServiceLog();
    statSync.mockReturnValue({ size: 10 } as unknown as ReturnType<typeof fs.statSync>);

    // A circular structure makes JSON.stringify throw; the logger must degrade
    // to a minimal serializable line rather than take the process down.
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() =>
      serviceLog({ level: "error", subsystem: "test", msg: "circular", data: circular }),
    ).not.toThrow();

    // Both the console tee and the file append still fire, with the fallback shape.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(appendFileSync.mock.calls[0][1]).trimEnd());
    expect(parsed.serialization).toBe("failed");
    expect(parsed.msg).toBe("circular");
    expect(parsed.subsystem).toBe("test");
    expect(parsed.ts).toEqual(expect.any(String));
  });
});
