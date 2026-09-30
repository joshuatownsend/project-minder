import "server-only";
import { resolveIngestMode, type IngestMode } from "./ingestMode";

// "Has the initial reconcile finished?" — asked so that whole-corpus JSONL
// sweeps can stay out of its way (#585).
//
// **Why this exists.** Two full-corpus passes are enough to make the server
// unusable for minutes after boot: the ingest reconcile, and the usage parser's
// `parseAllSessions()` sweep that the boot-time efficiency-grade drain starts.
// Measured on a 6 GB / 14k-transcript corpus with both running at once, the
// server's main thread sat at 100% and `/api/health` took 3–6 s (#584). Neither
// pass needs the other; only the overlap hurts. The grade drain is the one that
// can wait, so it asks this first.
//
// **Why not `getIndexBuildState()`.** That latches to "ready" after the first
// pass ever completes, so at every ordinary boot — index already built — it
// answers "ready" from the first millisecond and would gate nothing. What is
// wanted here is narrower and per-process: this boot's initial pass is not done.
//
// **Why the same sources `/api/health` reads.** The reconcile runs in a worker
// thread in the packaged default and in-process otherwise (or after the worker
// falls back), so no single module variable can answer for both. `collectIngest`
// in the health route already resolves that and is the contract the tray trusts;
// this reads the same two accessors in the same order.

export interface IngestSettleInput {
  /** `MINDER_USE_DB !== "0"` — with the DB off nothing reconciles, so nothing to wait for. */
  useDb: boolean;
  /**
   * The index can never open here: the native driver is missing, or an open was
   * attempted and failed. `startIngestWatcher` then returns idle and
   * `initialReconcileMs` stays `null` forever — a wait would run to its ceiling
   * for a reconcile that cannot happen, delaying grades that never needed the
   * index (they are computed from the JSONL). "Not opened *yet*" is not this:
   * the ~100 s open on a large index is exactly the window worth waiting out.
   */
  dbUnusable: boolean;
  mode: IngestMode;
  /** The live watcher's `initialReconcileMs`; `null` until the pass settles (or before it starts). */
  initialReconcileMs: number | null;
}

/**
 * Pure decision: is this boot's initial reconcile still outstanding?
 *
 * `null` deliberately covers "not started yet" as well as "running": the
 * bootstrap enqueues its caches before the ingest watcher has even been asked to
 * start, and that early window is exactly the one to hold off in.
 */
export function initialReconcilePending(input: IngestSettleInput): boolean {
  if (!input.useDb || input.dbUnusable) return false;
  if (input.mode === "off") return false;
  return input.initialReconcileMs === null;
}

/**
 * Live reading of [`initialReconcilePending`]. O(1), in-memory, never throws.
 *
 * The two status modules are imported on demand: they sit on top of the whole
 * ingest stack (SQLite, chokidar, the worker host), and a caller that only wants
 * the pure predicate or the wait loop should not pay to load it.
 */
export async function readInitialReconcilePending(): Promise<boolean> {
  // Vitest sets NODE_ENV=test and `startIngestWatcher` refuses to arm there, so
  // `initialReconcileMs` would stay null for the life of the run and every test
  // that drains the grade cache would sit out the full ceiling. Same gate, same
  // reason, as the watcher's own.
  if (process.env.NODE_ENV === "test") return false;
  try {
    const [{ getWorkerStatus }, { getWatcherStatus, isIndexUnusable }] = await Promise.all([
      import("./workerHost"),
      import("./ingestWatcher"),
    ]);
    const worker = getWorkerStatus();
    const initialReconcileMs = worker.running
      ? (worker.watcher?.initialReconcileMs ?? null)
      : getWatcherStatus().initialReconcileMs;
    return initialReconcilePending({
      useDb: process.env.MINDER_USE_DB !== "0" && process.env.MINDER_DEMO !== "1",
      dbUnusable: isIndexUnusable(),
      mode: resolveIngestMode(),
      initialReconcileMs,
    });
  } catch {
    // A status read that cannot answer must not be the reason grades never
    // compute: fail open, exactly as the readiness predicates in indexerRuns do.
    return false;
  }
}

/** Poll cadence and ceiling for [`waitUntilSettled`]. */
export const SETTLE_POLL_MS = 5_000;
/**
 * Longest a deferred sweep will wait. A bound, not an expectation: the reconcile
 * took ~11.5 min on the measured corpus and a DERIVED_VERSION re-derivation can
 * take far longer, but a sweep that never runs is a worse failure than one that
 * overlaps — the grades would be missing for the life of the process. If ingest
 * never reports (worker and fallback both failed), this is what ends the wait.
 */
export const SETTLE_MAX_WAIT_MS = 30 * 60_000;

export interface WaitOptions {
  pollMs?: number;
  maxWaitMs?: number;
  /** Injectable so tests advance time without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve once `isPending()` turns false, or once `maxWaitMs` of polling has
 * elapsed. Elapsed time is counted from the polls themselves rather than the
 * wall clock, which keeps it deterministic under an injected `sleep`.
 */
export async function waitUntilSettled(
  isPending: () => boolean | Promise<boolean>,
  options: WaitOptions = {}
): Promise<"settled" | "timed-out"> {
  const pollMs = options.pollMs ?? SETTLE_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? SETTLE_MAX_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let waited = 0;
  while (await isPending()) {
    if (waited >= maxWaitMs) return "timed-out";
    await sleep(pollMs);
    waited += pollMs;
  }
  return "settled";
}
