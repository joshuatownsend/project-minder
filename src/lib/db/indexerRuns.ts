import "server-only";
import type DatabaseT from "better-sqlite3";
import { resolveIngestMode } from "./ingestMode";

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
 * How many aborted rows the table keeps while readiness is unestablished.
 * Enough to show a pattern to anyone who looks; small enough that a persistent
 * failure cannot grow the table without bound.
 *
 * Bounds the TABLE, not the recording — those are different things, and the
 * first version of this bounded the wrong one. Capping recording meant that
 * after 20 aborted sweeps no *further* sweep was recorded at all, including the
 * one that finally succeeded once the underlying fault (a permission problem on
 * a mount, a distro that came back) was fixed. Readiness could then never latch
 * within the process's lifetime, which is precisely the standing outage
 * `recordOptionForSweep` was added to prevent. Pruning instead keeps the
 * recovery path open forever at a fixed storage cost.
 */
const ABORTED_RUN_KEEP_LIMIT = 20;

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
  /**
   * What went wrong, if anything. Set for BOTH a pass that completed with some
   * files unparseable and one that did not complete at all — `aborted` is what
   * separates them.
   */
  error?: string | null;
  /**
   * The pass did not finish: it threw, or the process died and a later start
   * closed the row. Readiness turns on this, so it must not be conflated with
   * `error` (#471, Codex P1 + Copilot).
   */
  aborted?: boolean;
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
          SET finished_at_ms = ?, files_seen = ?, files_changed = ?, rows_written = ?,
              error = ?, aborted = ?
        WHERE id = ?`
    ).run(
      Date.now(),
      result.filesSeen ?? 0,
      result.filesChanged ?? 0,
      result.rowsWritten ?? 0,
      result.error ?? null,
      result.aborted ? 1 : 0,
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
            SET finished_at_ms = ?, error = 'orphaned', aborted = 1
          WHERE finished_at_ms IS NULL`
      )
      .run(Date.now());
    return Number(info.changes ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Has a full-corpus pass ever **completed** against this index?
 *
 * Finished is not the same as completed, and conflating them reintroduced the
 * exact bug this module exists to prevent: a pass that threw, or one orphaned
 * by a kill and closed at the next startup, both have `finished_at_ms` set — so
 * a killed first reconcile flipped the index to ready and the engagement report
 * went straight back to answering from a half-built index. `aborted` is the
 * discriminator. (Codex P1 + Copilot, PR #471.)
 *
 * A completed run with a non-null `error` still counts. There, `error` means
 * some individual files did not parse — the corpus was still read through, and
 * treating one bad transcript as "never indexed" would hold the report offline
 * indefinitely. That reading is deliberate, and it is why `aborted` needed its
 * own column rather than being inferred from `error`.
 */
export function hasCompletedFullReconcile(db: DatabaseT.Database): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM indexer_runs
          WHERE finished_at_ms IS NOT NULL AND aborted = 0 AND kind IN ('reconcile','rebuild')
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
 * What a 30 s SWEEP pass should record, if anything.
 *
 * Sweeps normally record nothing — they run forever, and a row every half
 * minute is noise. But if the initial pass aborted (it threw, or the process
 * died) then nothing else will ever establish readiness: the initial reconcile
 * does not retry, and an unrecorded sweep cannot clear the latch. The engagement
 * report would then 503 **permanently** on an index that sweeps had long since
 * populated — a fix for a wrong number turning into a standing outage, which is
 * the same trap the withdrawn migration backfill was reaching for and got wrong
 * in the other direction. (Copilot, PR #471; the second half of Codex's P1,
 * which said to let a later successful sweep establish readiness and which the
 * first fix did not implement.)
 *
 * Self-limiting: recording stops as soon as one non-aborted pass exists, so the
 * steady state is still zero rows per sweep.
 */
export function recordOptionForSweep(
  db: DatabaseT.Database
): { recordRun?: IndexerRunKind } {
  if (hasCompletedFullReconcile(db)) return {};
  // Bounded — by pruning, not by giving up. A sweep records every 30 s while
  // readiness is unestablished, which is ~2,880 rows a day if enumeration keeps
  // failing. Dropping all but the newest `ABORTED_RUN_KEEP_LIMIT` aborted rows
  // holds the table flat while leaving every future sweep free to record, so
  // the sweep that finally succeeds still clears the latch however long the
  // fault lasted. See `ABORTED_RUN_KEEP_LIMIT` for why capping the recording
  // instead was wrong.
  pruneAbortedRuns(db);
  return { recordRun: "reconcile" };
}

/**
 * Keep only the newest `ABORTED_RUN_KEEP_LIMIT` aborted rows.
 *
 * Never touches a completed row: those are the readiness evidence, and there is
 * at most one that matters anyway (recording stops the moment one exists).
 */
function pruneAbortedRuns(db: DatabaseT.Database): void {
  try {
    db.prepare(
      `DELETE FROM indexer_runs
        WHERE aborted = 1
          AND id NOT IN (
            SELECT id FROM indexer_runs WHERE aborted = 1
             ORDER BY id DESC LIMIT ?
          )`
    ).run(ABORTED_RUN_KEEP_LIMIT);
  } catch {
    /* housekeeping must not destabilize ingest */
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
 * empty the table.
 *
 * **A consumer that reads *derived* columns is only half-covered by this.** It
 * still answers "is the corpus fully ingested", which is what the first-build
 * case needs — but not "are the derived values consistent", which a rebuild
 * breaks by rewriting rows one file at a time. #472 attached five such
 * consumers in `data/index.ts` knowingly: the first-build gap was live and this
 * closes it, while the rebuild gap is unchanged from before them and needs a
 * predicate that does not exist yet. Do not read their use of this as evidence
 * that a rebuild is covered. Tracked as #478. (Codex P1, PR #474.)
 */
export function getIndexBuildState(db: DatabaseT.Database): IndexBuildState {
  // "Building" is a claim that something is actively reading the corpus. With
  // `MINDER_INDEXER=0` nothing is, and nothing ever will be — so the latch would
  // never clear and the report would be offline permanently rather than
  // temporarily. The operator has switched ingest off and owns the index's
  // freshness; saying "still indexing" at them would be false.
  //
  // This is what pays for dropping the migration backfill. Crediting an existing
  // index with a pass nobody recorded was rejected as fabricated evidence
  // (Codex P1, PR #471) — a killed pre-upgrade reconcile leaves a NON-EMPTY
  // sessions table, so non-emptiness never proved a full pass finished. Without
  // the backfill an ordinary install is briefly "building" after upgrade until
  // its first recorded pass lands, which is honest and self-resolving; only the
  // indexer-off configuration needed an answer, and this is it.
  if (resolveIngestMode(process.env) === "off") return "ready";
  return hasCompletedFullReconcile(db) ? "ready" : "building";
}

/** `meta` key holding the latest full-pass verdict; see the two functions below. */
const SWEEP_VERDICT_KEY = "last_full_sweep_incomplete";

/**
 * Record whether the full pass that just finished read the corpus through.
 *
 * Written to `meta` on EVERY full reconcile, and that is the point rather than
 * a duplicate of the run row. `recordOptionForSweep` deliberately stops writing
 * `indexer_runs` rows once any clean full pass exists — the rows exist to clear
 * a readiness latch, not to log — so the steady-state 30-second sweeps record
 * nothing. Reading the latest RECORDED run therefore answered with the startup
 * pass forever, and a permissions failure appearing later stayed invisible.
 * (Codex P2, PR #527.)
 *
 * One row, overwritten. This is a current-state flag, not a history.
 */
export function recordFullPassVerdict(
  db: DatabaseT.Database,
  incomplete: boolean
): void {
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      SWEEP_VERDICT_KEY,
      incomplete ? "1" : "0"
    );
  } catch {
    // A diagnostic must never be the thing that fails an ingest pass.
  }
}

/**
 * Forget the persisted verdict, because the corpus it described is gone.
 *
 * The in-process collector is cleared on a config change for exactly this
 * reason; the persisted flag needed the same treatment and did not have it, so
 * removing an unreadable home left `complete: false` standing until another
 * full reconcile ran — indefinitely if the indexer is disabled or stopped.
 * (Codex P2, PR #527.)
 *
 * DELETED rather than set to "0": absence means "no full pass has reported
 * since the corpus changed", which is the honest state and is exactly what the
 * run-row fallback below already handles. Writing "0" would assert a clean pass
 * that never happened.
 */
export function clearPersistedSweepVerdict(db: DatabaseT.Database): void {
  try {
    db.prepare("DELETE FROM meta WHERE key = ?").run(SWEEP_VERDICT_KEY);
  } catch {
    // A diagnostic reset must never fail a config write.
  }
}

/**
 * Did the most recent full pass fail to read something it was supposed to?
 *
 * The DB reconcile has its own enumeration-failure count, but it never reached
 * the sweep-failure collector — so on a DB-backed setup (the default) where
 * neither instrumented file sweep runs, `/api/claude-homes` answered
 * `complete: true` over an index pass explicitly marked incomplete.
 * (Codex P2, PR #527.)
 *
 * Read from the DATABASE rather than from a collector, and that is the whole
 * reason this lives here: the reconcile runs in `workers/ingestWorker.mjs`,
 * whose `globalThis` is isolated from the HTTP server's, so no in-process
 * record could cross. #478 established the same seam for the same reason —
 * the shared file is the evidence both processes can see.
 *
 * The run-row fallback is scoped to full-corpus kinds. A tail or watcher pass
 * reads one file and cannot speak to whether the corpus was enumerable, so an
 * unscoped query would let a later clean tail mask an aborted reconcile.
 */
export function lastFullPassWasIncomplete(db: DatabaseT.Database): boolean {
  try {
    const flag = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(SWEEP_VERDICT_KEY) as { value: string } | undefined;
    if (flag) return flag.value === "1";
  } catch {
    // Fall through to the run row.
  }
  try {
    // Fallback for an index written before the flag existed, and only until its
    // next full pass sets one. Scoped to full-corpus kinds: a tail or watcher
    // pass reads one file and cannot speak to whether the corpus was
    // enumerable, so an unscoped query would let a later clean tail mask an
    // aborted reconcile.
    const row = db
      .prepare(
        `SELECT aborted FROM indexer_runs
          WHERE finished_at_ms IS NOT NULL AND kind IN ('reconcile','rebuild')
          ORDER BY finished_at_ms DESC LIMIT 1`
      )
      .get() as { aborted: number } | undefined;
    return row?.aborted === 1;
  } catch {
    // No table yet, or an index too old to have one. "Nothing is known to have
    // failed" is the honest answer there, and it is what every other read in
    // this file falls back to.
    return false;
  }
}
