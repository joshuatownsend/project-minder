import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stopWorker } from "@/lib/db/workerHost";

// Codex, PR #601 (P1): stopWorker() used to resolve normally after a
// terminate(), so the ingest disposer counted as clean and the next boot trusted
// a clean-shutdown marker over an index whose writer may have died mid-write.
// It now reports `forced`, but only for a worker that had reached `ready`.

type G = { __minderWorker?: unknown };
const g = globalThis as unknown as G;

function installFakeWorker(opts: { lastReadyAt: number | null; exitsOnStop: boolean }) {
  let exitCb: (() => void) | null = null;
  const terminate = vi.fn(async () => 0);
  const worker = {
    threadId: 7,
    postMessage: vi.fn(() => {
      if (opts.exitsOnStop) queueMicrotask(() => exitCb?.());
    }),
    once: vi.fn((ev: string, cb: () => void) => {
      if (ev === "exit") exitCb = cb;
    }),
    terminate,
  };
  g.__minderWorker = {
    worker,
    stopping: false,
    respawnTimer: null,
    readyTimeout: null,
    readyReject: null,
    readyResolve: null,
    messageSubscribers: new Set(),
    lastReadyAt: opts.lastReadyAt,
  };
  return { terminate };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete g.__minderWorker;
});

describe("stopWorker reports forced termination", () => {
  it("forced=true when a post-ready worker misses the grace period and is terminated", async () => {
    const { terminate } = installFakeWorker({ lastReadyAt: 1, exitsOnStop: false });
    const p = stopWorker();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toEqual({ forced: true });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("forced=false when the worker exits on its own within the grace period", async () => {
    const { terminate } = installFakeWorker({ lastReadyAt: 1, exitsOnStop: true });
    const p = stopWorker();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual({ forced: false });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("forced=false for a worker that never reached ready (not running ingest)", async () => {
    const { terminate } = installFakeWorker({ lastReadyAt: null, exitsOnStop: false });
    await expect(stopWorker()).resolves.toEqual({ forced: false });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("forced=false when there is nothing to stop", async () => {
    await expect(stopWorker()).resolves.toEqual({ forced: false });
  });
});
