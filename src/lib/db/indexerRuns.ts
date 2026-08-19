import "server-only";
import type DatabaseT from "better-sqlite3";

// Whether the index has finished populating, recorded as a fact in the index
// itself rather than inferred by whoever happens to be asking.
//
// #470: the server answers requests while the initial reconcile runs — it has
// to, or it is #413, a server that accepts connections and answers nothing for
// the length of a full corpus re-parse. But some reads are not safe to answer
// from a half-built index. `getEngagement()` is the sharp case: it reports
// billable hours, and "0.0 hours" during a rebuild is indistinguishable from a
// true zero. A wrong number stated confidently is worse than an error.
//
// **Why the index and not a module variable.** The reconcile runs in a
// `worker_threads` thread in the packaged default (#431), so nothing in the
// main process's memory can see it. The two processes already share exactly one
// thing — the database — so that is where the fact belongs. `indexer_runs` was
// declared in the original schema for this and never written; this module is
// the writer it was waiting for.

/** Full-corpus passes only. The 30 s sweep is not one — see `recordRun`. */
export type IndexerRunKind = "reconcile" | "rebuild";

export type IndexBuildState = "building" | "ready";

/**
 * Open a run row and return its id.
 *
 * Written as its own statement rather than inside the reconcile's transaction:
 * the whole point is for another process to observe it *while* the pass runs,
 * and an uncommitted row is invisible.
 *
 * Returns null on failure. A readiness signal must never be the reason an
 * ingest pass does not happen.
 */
export function beginIndexerRun(
  db: DatabaseT.Database,
  kind: IndexerRunKind
): number | null {
  try {
    const info = db
      .prepare(
        `INSERT INTO indexer_runs (started_at_ms, kind, files_seen, files_changed, rows_written)
         VALUES (?, ?, 0, 0, 0)`
      )
      .run(Date.now(), kind);
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

export interface IndexerRunResult {
  filesSeen?: number;
  filesChanged?: number;
  rowsWritten?: number;
  /** Non-null marks the pass as failed; it still counts as finished. */
  error?: string | null;
}

/**
 * Close a run row. Call from a `finally` — a pass that threw still has to stop
 * reading as in-progress, or the gate latches on forever.
 */
export function finishIndexerRun(
  db: DatabaseT.Database,
  id: number | null,
  result: IndexerRunResult = {}
): void {
  if (id === null) return;
  try {
    db.prepare(
      `UPDATE indexer_runs
          SET finished_at_ms = ?, files_seen = ?, files_changed = ?, rows_written = ?, error = ?
        WHERE id = ?`
    ).run(
      Date.now(),
      result.filesSeen ?? 0,
      result.filesChanged ?? 0,
      result.rowsWritten ?? 0,
      result.error ?? null,
      id
    );
  } catch {
    /* observability must not destabilize ingest */
  }
}

/**
 * Mark runs left open by a process that died mid-pass.
 *
 * Without this the gate lies permanently in one direction: a kill during the
 * first reconcile leaves `finished_at_ms IS NULL` forever, and any predicate
 * reading "an open run exists" would report building for the life of the index.
 *
 * Safe to do unconditionally at watcher start because only one ingest pipeline
 * runs at a time — the worker→in-process fallback tears the worker down before
 * starting the watcher, and `startIngestWatcher` stops any prior watcher first.
 * So an open row at this moment is by construction not a live one.
 */
export function closeOrphanedIndexerRuns(db: DatabaseT.Database): number {
  try {
    const info = db
      .prepare(
        `UPDATE indexer_runs
            SET finished_at_ms = ?, error = 'orphaned'
          WHERE finished_at_ms IS NULL`
      )
      .run(Date.now());
    return Number(info.changes ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Has a full-corpus pass ever finished against this index?
 *
 * A failed run still counts. `error` on a run means some files did not parse,
 * not that the pass did not happen — the index is populated either way, and
 * treating a single bad transcript as "never indexed" would hold a report
 * offline indefinitely over one unparseable file. The alternative reading was
 * considered and rejected for that reason.
 */
export function hasCompletedFullReconcile(db: DatabaseT.Database): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM indexer_runs
          WHERE finished_at_ms IS NOT NULL AND kind IN ('reconcile','rebuild')
          LIMIT 1`
      )
      .get() as { ok?: number } | undefined;
    return !!row?.ok;
  } catch {
    // No table, or an unreadable one: do not gate. A readiness check that
    // cannot read its own evidence must not be the thing that takes a report
    // offline — it would convert a schema problem into a silent outage.
    return true;
  }
}

/**
 * `'building'` until the index has completed its first full pass.
 *
 * Deliberately NOT "a reconcile is running right now". The 30 s sweep re-runs
 * `reconcileAllSessions` forever, so a live-run predicate would flap a report
 * in and out of availability every half minute for the life of the process.
 * What consumers actually need to know is whether the corpus has been read
 * through **once**, which is a latch: false until it happens, true thereafter.
 *
 * A `DERIVED_VERSION` rebuild therefore does not report building, and for the
 * consumer this exists for that is correct rather than merely convenient:
 * `loadEngagementReportFromSql` reads only raw columns (`ts`, `role`,
 * `text_preview`, `tool_result_preview`, `entrypoint`, `is_sidechain`), all of
 * which survive a re-derivation. A rebuild changes derived values; it does not
 * empty the table. Any future consumer that reads *derived* columns needs a
 * different predicate, and should not reach for this one.
 */
export function getIndexBuildState(db: DatabaseT.Database): IndexBuildState {
  return hasCompletedFullReconcile(db) ? "ready" : "building";
}
