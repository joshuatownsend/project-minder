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

  if (process.env.MINDER_INDEXER !== "0") {
    await startInProcessWatcher();
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
