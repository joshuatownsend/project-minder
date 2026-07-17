import "server-only";

// Node-runtime-only instrumentation. Imported via dynamic `await import()`
// from `instrumentation.ts` after that file's `process.env.NEXT_RUNTIME`
// gate. Splitting the Node logic here is the only way to keep Turbopack
// from compiling the `@/lib/db/...` chain for the Edge runtime — every
// module in that graph uses `fs`, `process.cwd()`, `child_process`, etc.
// `'server-only'` at the top makes Turbopack refuse Edge compilation of
// this file outright, severing the trace at the dynamic-import boundary.
//
// Three ingest modes, in priority order:
//
//   MINDER_INDEXER_WORKER=1  → start the worker_threads-hosted ingest.
//                              Strictly opt-in until worker mode is
//                              burned in.
//   default                  → start the in-process chokidar watcher.
//                              The dashboard's default read path is
//                              SQL-backed, which depends on this
//                              watcher keeping the index fresh. Set
//                              `MINDER_INDEXER=0` to disable.
//
// To run with neither — pure file-parse mode — set both
// `MINDER_INDEXER=0` and `MINDER_USE_DB=0`.

export async function startIngest(): Promise<void> {
  // Boot-time bootstrap (service-mode A1): warms the project-scan cache, the
  // git-status/efficiency-grade/GitHub-activity background caches, the
  // manual-steps watcher, and the MCP config/health watchers — the same work
  // `/api/projects` + `/api/manual-steps/changes` + `/api/mcp-health` would
  // otherwise only do lazily on first dashboard load. Self-gated inside
  // `runBootstrap()` (prod-only by default, `MINDER_BOOTSTRAP=1/0` override,
  // always skipped in demo mode) — safe to call unconditionally here.
  await bootstrapMinder();

  // Start the task/swarm dispatcher at server boot rather than lazily on a GET
  // request. Two reasons: (1) it resumes any pending tasks after a restart
  // without waiting for a dashboard visit, and (2) it closes a CSRF vector —
  // /api/tasks and /api/swarms GET handlers used to call initDispatcher(), so a
  // cross-site origin-less `<img src>` GET could start the dispatcher (which
  // claims pending tasks and spawns work). initDispatcher() is idempotent, and
  // this runs independently of the indexer mode below.
  await startDispatcher();

  // Register the graceful-shutdown disposer for whichever ingest mode starts
  // below. The ingest pipeline (worker OR in-process watcher) is started here,
  // AFTER runBootstrap(), so it isn't covered by the disposers the bootstrap
  // registers — without this, shutdown could close SQLite while ingest is
  // mid-write. Registered after runBootstrap()'s `sqlite` disposer, so LIFO
  // disposal stops ingest BEFORE the DB handle closes.
  await registerIngestDisposer();

  if (process.env.MINDER_INDEXER_WORKER === "1") {
    try {
      const { startWorker, stopWorker, onWorkerMessage } = await import("@/lib/db/workerHost");
      // awaitStart: false — return as soon as the worker is alive and
      // the watcher module is loaded. The initial reconcile runs in
      // the background; instrumentation doesn't block server startup
      // on it.
      //
      // onStartFailure — if the async start handshake fails (worker
      // is alive but the watcher inside it couldn't start, e.g. DB
      // driver unavailable or watcher init throws), tear down the
      // worker and switch to the in-process watcher so ingest doesn't
      // silently stay off.
      const status = await startWorker({
        awaitStart: false,
        onStartFailure: (err: Error) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[ingest-worker] async start failed (${err.message}); switching to in-process watcher.`
          );
          void stopWorker().then(() => startInProcessWatcher());
        },
      });
      if (status.running) {
        // eslint-disable-next-line no-console
        console.info(`[ingest-worker] spawned; entry=${status.workerEntry}`);
      }
      // The worker acks `started` before its initial reconcile finishes
      // (deferInitialReconcile) — log the completion message so a slow
      // full re-parse after a DERIVED_VERSION bump is visible instead of
      // silent.
      onWorkerMessage((msg) => {
        if (!msg || typeof msg !== "object") return;
        const m = msg as { type?: string; ms?: number; error?: string };
        if (m.type === "initial-reconcile") {
          // eslint-disable-next-line no-console
          console.info(
            `[ingest-worker] initial reconcile finished in ${m.ms} ms` +
              (m.error ? ` (error: ${m.error})` : "")
          );
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ingest-worker] failed to start: ${(err as Error).message}. ` +
          `Falling back to in-process watcher (MINDER_INDEXER mode).`
      );
      // Tear down the worker host before handing off. Otherwise a
      // pending crash-respawn (a non-zero pre-ready exit triggers the
      // exit handler's respawn loop independently of the rejected
      // startWorker promise) would run alongside the in-process
      // watcher and we'd have two ingest pipelines fighting for the
      // writer connection.
      try {
        const { stopWorker } = await import("@/lib/db/workerHost");
        await stopWorker();
      } catch {
        /* swallow — best-effort teardown */
      }
      await startInProcessWatcher();
    }
    return;
  }

  if (process.env.MINDER_INDEXER !== "0") {
    await startInProcessWatcher();
  }
}

async function bootstrapMinder(): Promise<void> {
  try {
    const { runBootstrap } = await import("@/lib/bootstrap");
    await runBootstrap();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[bootstrap] failed to run: ${(err as Error).message}`);
  }
}

async function startDispatcher(): Promise<void> {
  try {
    const { initDispatcher } = await import("@/lib/tasks/dispatcher");
    initDispatcher();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[dispatcher] failed to start at boot: ${(err as Error).message}`);
  }
}

async function registerIngestDisposer(): Promise<void> {
  try {
    // Only wire this in service mode, where runBootstrap() actually installed
    // the signal handlers and registered the other disposers. If bootstrap
    // didn't run (plain `next dev`), nothing will ever fire a disposer, so
    // there's no point populating the registry.
    const { getBootstrapStatus } = await import("@/lib/bootstrap");
    if (!getBootstrapStatus().ran) return;

    const { onShutdown } = await import("@/lib/lifecycle");
    onShutdown("ingest", async () => {
      // Stop whichever ingest mode is live before SQLite closes. Both stops are
      // idempotent no-ops when their mode isn't active, so calling both covers
      // worker mode, in-process mode, and the worker→in-process fallback.
      // stopWorker() posts `stop` and waits for a clean between-transaction
      // exit (up to a grace period) before terminating — the whole point is to
      // not hard-kill a worker mid-better-sqlite3-write.
      const [{ stopWorker }, { stopIngestWatcher }] = await Promise.all([
        import("@/lib/db/workerHost"),
        import("@/lib/db/ingestWatcher"),
      ]);
      await stopWorker();
      await stopIngestWatcher();
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ingest] failed to register shutdown disposer: ${(err as Error).message}`);
  }
}

async function startInProcessWatcher(): Promise<void> {
  try {
    const { startIngestWatcher } = await import("@/lib/db/ingestWatcher");
    // Pass `bypassEnvFlag: true` because we only reach this function
    // after the parent `instrumentation.ts` runtime/test gate passes
    // AND `startIngest()` above has handled the `MINDER_INDEXER*` mode
    // selection. Re-checking the env flag inside the watcher would
    // (a) double-gate, and (b) wrongly skip the worker fallback path,
    // where the user set `MINDER_INDEXER_WORKER=1` but not
    // `MINDER_INDEXER=1`. The watcher's own NODE_ENV=test guard is
    // also bypassed by this option — defense-in-depth lives at the
    // top of `instrumentation.ts` instead.
    const status = await startIngestWatcher({ bypassEnvFlag: true });
    if (status.running) {
      // eslint-disable-next-line no-console
      console.info(
        `[ingest-watcher] started; initial reconcile took ${status.initialReconcileMs ?? "?"} ms`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] failed to start: ${(err as Error).message}. ` +
        `Dashboard continues on the file-parse path.`
    );
  }
}
