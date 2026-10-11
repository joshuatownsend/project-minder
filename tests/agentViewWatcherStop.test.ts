import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #657: both Agent View watchers can now be stopped. The watch is installed
// after an async `fs.access`, so a stop that lands first must still cancel it,
// and a stop must not be mistaken for "recursive watch unsupported".

const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  watch: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, default: actual, promises: { ...actual.promises, ...fsMock } };
});

import { startJsonlWatcher, stopJsonlWatcher } from "@/lib/agentView/jsonlWatcher";
import { startJobRosterWatcher, stopJobRosterWatcher } from "@/lib/agentView/jobRoster";

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/** An `fs.promises.watch` stand-in that yields nothing and ends on abort, like the real one. */
function abortableWatch(_dir: string, opts: { signal: AbortSignal }) {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<never>((_, reject) => {
        if (opts.signal.aborted) reject(abortError());
        opts.signal.addEventListener("abort", () => reject(abortError()));
      });
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  delete g.__minderJsonlWatcher;
  delete g.__minderJobRosterWatch;
  delete g.__minderJobRosterSweepTimer;
  fsMock.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  fsMock.watch.mockImplementation(abortableWatch);
});

afterEach(() => {
  stopJsonlWatcher();
  stopJobRosterWatcher();
  vi.useRealTimers();
});

describe("jsonlWatcher start/stop", () => {
  it("a stop before the directory check resolves never installs a watch", async () => {
    const access = deferred();
    fsMock.access.mockReturnValue(access.promise);
    startJsonlWatcher();
    stopJsonlWatcher();
    access.resolve();
    await flush();
    expect(fsMock.watch).not.toHaveBeenCalled();
  });

  it("stop aborts the watch, and the next start watches again", async () => {
    fsMock.access.mockResolvedValue(undefined);
    startJsonlWatcher();
    await flush();
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    const { signal } = fsMock.watch.mock.calls[0][1] as { signal: AbortSignal };
    stopJsonlWatcher();
    expect(signal.aborted).toBe(true);
    await flush();
    startJsonlWatcher();
    await flush();
    expect(fsMock.watch).toHaveBeenCalledTimes(2);
  });

  it("a real watch failure stays sticky across restarts", async () => {
    fsMock.access.mockResolvedValue(undefined);
    fsMock.watch.mockImplementation(() => {
      throw Object.assign(new Error("not recursive"), { code: "ERR_FS_WATCH_NOT_RECURSIVE" });
    });
    startJsonlWatcher();
    await flush();
    stopJsonlWatcher();
    startJsonlWatcher();
    await flush();
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
  });
});

describe("jobRoster start/stop", () => {
  it("a stop before the directory check resolves never installs a watch", async () => {
    const access = deferred();
    fsMock.access.mockReturnValue(access.promise);
    startJobRosterWatcher();
    stopJobRosterWatcher();
    access.resolve();
    await flush();
    expect(fsMock.watch).not.toHaveBeenCalled();
  });

  it("stop aborts the watch and ends the 5 s sweep", async () => {
    vi.useFakeTimers();
    fsMock.access.mockResolvedValue(undefined);
    startJobRosterWatcher();
    await vi.advanceTimersByTimeAsync(0);
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    const { signal } = fsMock.watch.mock.calls[0][1] as { signal: AbortSignal };

    await vi.advanceTimersByTimeAsync(5_000);
    const readsWhileRunning = fsMock.readFile.mock.calls.length;
    expect(readsWhileRunning).toBeGreaterThan(1); // initial load + one sweep

    stopJobRosterWatcher();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fsMock.readFile.mock.calls.length).toBe(readsWhileRunning);
  });

  it("can be started again after a stop", async () => {
    fsMock.access.mockResolvedValue(undefined);
    startJobRosterWatcher();
    await flush();
    stopJobRosterWatcher();
    startJobRosterWatcher();
    await flush();
    expect(fsMock.watch).toHaveBeenCalledTimes(2);
  });
});
