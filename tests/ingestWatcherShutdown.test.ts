import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Isolated test for the A2 graceful-shutdown drain (F7): stopIngestWatcher()
// must not resolve until an in-flight reconcile has settled, so the `sqlite`
// disposer can't close index.db mid-write. Heavy deps are mocked so we can gate
// the reconcile deterministically (the real integration path lives in
// dbIngestWatcher.test.ts).

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/migrations", () => ({
  initDb: vi.fn().mockResolvedValue({ available: true }),
}));
vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn().mockResolvedValue({}),
  getDbSync: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/db/ingest", () => ({
  reconcileAllSessions: vi.fn(),
  reconcileSessionFile: vi.fn().mockResolvedValue({ rowsWritten: 0, affectedDays: [], affectedCategoryTuples: [] }),
  refreshDailyCosts: vi.fn(),
  refreshCategoryCosts: vi.fn(),
}));
// Minimal fake chokidar: a watcher that reaches `ready` immediately and closes
// cleanly, so startIngestWatcher() arms and returns without real FS events.
vi.mock("chokidar", () => ({
  watch: () => {
    const em = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
    em.close = async () => {};
    queueMicrotask(() => em.emit("ready"));
    return em;
  },
}));

import { startIngestWatcher, stopIngestWatcher, getWatcherStatus } from "@/lib/db/ingestWatcher";
import { reconcileAllSessions } from "@/lib/db/ingest";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // Make sure no watcher singleton leaks between tests.
  await stopIngestWatcher();
});

describe("stopIngestWatcher drain (F7)", () => {
  it("does not resolve until an in-flight initial reconcile settles", async () => {
    let releaseReconcile!: () => void;
    let reconcileFinished = false;
    const gate = new Promise<void>((resolve) => {
      releaseReconcile = () => {
        reconcileFinished = true;
        resolve();
      };
    });
    vi.mocked(reconcileAllSessions).mockReturnValue(gate as never);

    // Deferred mode kicks the initial reconcile in the background (tracked),
    // then arms the (fake) watcher and returns.
    await startIngestWatcher({
      bypassEnvFlag: true,
      projectsDir: "/fake/projects",
      deferInitialReconcile: true,
      disableSweep: true,
    });
    expect(getWatcherStatus().running).toBe(true);
    expect(reconcileAllSessions).toHaveBeenCalledTimes(1);

    // Begin shutdown while the reconcile is still gated.
    let stopResolved = false;
    const stopP = stopIngestWatcher().then(() => {
      stopResolved = true;
    });

    // Give the microtask queue a few turns — stop() must still be draining.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(reconcileFinished).toBe(false);

    // Let the reconcile finish; only now may stop() resolve.
    releaseReconcile();
    await stopP;
    expect(stopResolved).toBe(true);
    expect(reconcileFinished).toBe(true);
    // Singleton torn down.
    expect(getWatcherStatus().running).toBe(false);
  });

  it("sets stopped so a queued reconcile does not start after shutdown begins", async () => {
    // First reconcile resolves immediately (initial pass completes).
    vi.mocked(reconcileAllSessions).mockResolvedValue(undefined as never);

    await startIngestWatcher({
      bypassEnvFlag: true,
      projectsDir: "/fake/projects",
      deferInitialReconcile: false, // inline: initial reconcile awaited before return
      disableSweep: true,
    });
    expect(reconcileAllSessions).toHaveBeenCalledTimes(1);

    await stopIngestWatcher();
    expect(getWatcherStatus().running).toBe(false);
    // No further reconcile passes were scheduled/started by the teardown.
    expect(reconcileAllSessions).toHaveBeenCalledTimes(1);
  });
});
