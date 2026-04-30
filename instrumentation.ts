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

  if (process.env.MINDER_INDEXER_WORKER === "1") {
    try {
      const { startWorker } = await import("@/lib/db/workerHost");
      const status = await startWorker();
      if (status.running) {
        // eslint-disable-next-line no-console
        console.info(
          `[ingest-worker] started; entry=${status.workerEntry}`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ingest-worker] failed to start: ${(err as Error).message}. ` +
          `Falling back to in-process watcher (MINDER_INDEXER mode).`
      );
      // Fall through to the in-process path so the user always has
      // working ingest while we de-risk the worker integration.
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
