import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #413 — `instrumentation.ts` awaits `register()`, and Next dispatches no
// request until it resolves. Ingest startup ran INSIDE that hook, so the
// packaged server accepted connections and answered none of them — static
// assets included, and with `MINDER_DEMO=1` set, where no backend should be
// consulted at all.
//
// Two separate phases blocked, which is why the first fix was not enough: the
// inline initial reconcile (~3 hours on a 6,078-session corpus, #431), and then
// chokidar's `ready` handshake, measured hitting its own 30 s timeout. Both
// properties are pinned below — the second one is the load-bearing test, since
// deferring the reconcile alone still left the server dark for 30 s.

type WatcherOpts = Record<string, unknown>;

let watcherGate: Promise<void> = Promise.resolve();
const startIngestWatcher = vi.fn(async (_opts?: WatcherOpts) => {
  await watcherGate;
  return { running: true, initialReconcileMs: null };
});
const startWorker = vi.fn(async () => ({ running: true, workerEntry: "w.mjs" }));

vi.mock("@/lib/db/ingestWatcher", () => ({
  startIngestWatcher,
  stopIngestWatcher: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/workerHost", () => ({
  startWorker,
  stopWorker: vi.fn(async () => {}),
  onWorkerMessage: vi.fn(),
}));
vi.mock("@/lib/bootstrap", () => ({
  installServiceLifecycle: vi.fn(async () => {}),
  runBootstrap: vi.fn(async () => {}),
  // `ran: false` short-circuits the shutdown-disposer registration, which is
  // not what these tests are about.
  getBootstrapStatus: () => ({ ran: false }),
}));
vi.mock("@/lib/tasks/dispatcher", () => ({ initDispatcher: vi.fn() }));

/** Poll until the watcher has been asked to start (it is no longer awaited). */
async function waitForWatcherCall(timeoutMs = 5000): Promise<WatcherOpts> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (startIngestWatcher.mock.calls.length > 0) {
      return startIngestWatcher.mock.calls[0][0]!;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("startIngestWatcher was never called");
}

// Saved and restored one variable at a time rather than by looping over a list:
// `dbIsolationGuard.test.ts` verifies restoration by STATIC analysis, and a
// dynamic `process.env[k]` is invisible to it. That guard exists because a
// variable left set escapes into whatever file the vitest worker runs next,
// where it silently picks the wrong backend in a suite that never mentions it —
// so a restore that works but cannot be checked is not good enough here.
let savedIndexer: string | undefined;
let savedWorker: string | undefined;
let savedPackaged: string | undefined;

describe("startIngest — ingest startup must not block register() (#413)", () => {
  beforeEach(() => {
    savedIndexer = process.env.MINDER_INDEXER;
    savedWorker = process.env.MINDER_INDEXER_WORKER;
    savedPackaged = process.env.MINDER_PACKAGED;
    delete process.env.MINDER_INDEXER;
    delete process.env.MINDER_INDEXER_WORKER;
    delete process.env.MINDER_PACKAGED;
    watcherGate = Promise.resolve();
    startIngestWatcher.mockClear();
    startWorker.mockClear();
  });

  afterEach(() => {
    if (savedIndexer === undefined) delete process.env.MINDER_INDEXER;
    else process.env.MINDER_INDEXER = savedIndexer;
    if (savedWorker === undefined) delete process.env.MINDER_INDEXER_WORKER;
    else process.env.MINDER_INDEXER_WORKER = savedWorker;
    if (savedPackaged === undefined) delete process.env.MINDER_PACKAGED;
    else process.env.MINDER_PACKAGED = savedPackaged;
  });

  it("returns even though the watcher never finishes arming", async () => {
    // The whole defect in one assertion. `startIngestWatcher` here never
    // settles — standing in for chokidar walking a large projects tree — and
    // `startIngest()` must still resolve, because every millisecond it takes is
    // a millisecond Next serves nothing at all.
    watcherGate = new Promise<void>(() => {});
    const { startIngest } = await import("../instrumentation-node");

    const raced = await Promise.race([
      startIngest().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 2000)),
    ]);
    expect(raced).toBe("returned");
    // Fire-and-forget, not skipped: the watcher was still asked to start.
    await waitForWatcherCall();
  });

  it("defers the initial reconcile in in-process mode", async () => {
    const { startIngest } = await import("../instrumentation-node");
    await startIngest();
    const opts = await waitForWatcherCall();

    // Inline would keep the watcher un-armed for the length of a full corpus
    // re-parse, and would compete with the request path for the whole of it.
    expect(opts.deferInitialReconcile).toBe(true);
    // Still bypasses the env flag — mode selection happened in resolveIngestMode.
    expect(opts.bypassEnvFlag).toBe(true);
    // Completion must stay observable; `initialReconcileMs` is null at return now.
    expect(typeof opts.onInitialReconcile).toBe("function");
  });

  it("does not block on the watcher when the worker fails to start either", async () => {
    // The path that matters most: the worker could not start, so ingest falls
    // back to the in-process watcher. Blocking here would take the server dark
    // exactly when something is already wrong.
    process.env.MINDER_PACKAGED = "1";
    startWorker.mockRejectedValueOnce(new Error("worker entry missing"));
    watcherGate = new Promise<void>(() => {});
    const { startIngest } = await import("../instrumentation-node");

    const raced = await Promise.race([
      startIngest().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 2000)),
    ]);
    expect(raced).toBe("returned");
    const opts = await waitForWatcherCall();
    expect(opts.deferInitialReconcile).toBe(true);
  });

  it("starts no watcher at all when MINDER_INDEXER=0", async () => {
    process.env.MINDER_INDEXER = "0";
    const { startIngest } = await import("../instrumentation-node");
    await startIngest();
    await new Promise((r) => setTimeout(r, 50));
    expect(startIngestWatcher).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
  });
});
