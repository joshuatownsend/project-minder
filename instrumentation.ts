// Next.js instrumentation hook. Runs once per server process at startup —
// the canonical place for "things that should happen before any request."
//
// Three ingest modes, in priority order:
//
//   MINDER_INDEXER_WORKER=1  → start the worker_threads-hosted ingest
//                              (P2a-2.4; phase 1 = trivial ping/pong stub).
//   MINDER_INDEXER=1         → start the in-process chokidar watcher
//                              (P2a-2.2 / 2.3 path; remains the default
//                              and serves as the fallback if the worker
//                              path turns out to be broken on a given
//                              platform / Next.js version).
//   neither                  → no-op. Dashboard runs on the file-parse
//                              path. Ingest is strictly additive in P2a.
//
// We dynamic-import both options because:
//   1. Next.js calls `register` in both server runtimes; the modules are
//      `server-only` and fail to bundle in edge.
//   2. They import `better-sqlite3` (optional native binary) — keeping
//      the cost out of the cold-start critical path on platforms where
//      the binary isn't installed.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Vitest sets NODE_ENV=test. Do not start any ingest path in test
  // contexts — both the worker and the in-process watcher have their
  // own NODE_ENV gates, but we short-circuit here so a stray
  // instrumentation load (e.g. via dynamic-import in a test) never
  // races against tmpHome fixtures.
  if (process.env.NODE_ENV === "test") return;

  if (process.env.MINDER_INDEXER_WORKER === "1") {
    try {
      const { startWorker, stopWorker } = await import("@/lib/db/workerHost");
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

  if (process.env.MINDER_INDEXER === "1") {
    await startInProcessWatcher();
  }
}

async function startInProcessWatcher(): Promise<void> {
  try {
    const { startIngestWatcher } = await import("@/lib/db/ingestWatcher");
    // Pass `bypassEnvFlag: true` because instrumentation.ts has
    // already gated on the relevant env flags. The watcher's own
    // NODE_ENV=test guard is also bypassed by this option, which is
    // why we short-circuit on NODE_ENV=test at the top of register()
    // instead — keeping defense-in-depth without double-gating the
    // worker fallback path (where MINDER_INDEXER may not be set).
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
