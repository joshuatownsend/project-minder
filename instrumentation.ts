// Next.js instrumentation hook. Runs once per server process at startup —
// the canonical place for "things that should happen before any request."
//
// Used here to wire the SQLite ingest watcher behind the MINDER_INDEXER
// flag. Without the flag set, this is a no-op and the dashboard
// continues running on the file-parse path (P2a-2.2 is a strictly
// additive feature; nothing reads from the DB until P2b).
//
// We dynamic-import the watcher because:
//   1. Next.js calls `register` in both server runtimes; the watcher
//      is `server-only` and fails to bundle in edge.
//   2. The watcher imports `better-sqlite3` (optional native binary).
//      A dynamic import keeps the cost out of the cold-start critical
//      path on platforms where the binary isn't installed.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MINDER_INDEXER !== "1") return;

  try {
    const { startIngestWatcher } = await import("@/lib/db/ingestWatcher");
    const status = await startIngestWatcher();
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
