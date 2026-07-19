import "server-only";
import path from "path";
import os from "os";
import type { FSWatcher } from "chokidar";
import { initDb } from "./migrations";
import {
  reconcileAllSessions,
  reconcileSessionFile,
  refreshCategoryCosts,
  refreshDailyCosts,
} from "./ingest";
import { getDb, getDbSync } from "./connection";

// chokidar-driven incremental ingest.
//
// Lifecycle:
//
// 1. **Initial reconcile** — `reconcileAllSessions(db)` once at startup.
//    Covers everything that existed before the watcher was running.
//
// 2. **Watch** — chokidar on `~/.claude/projects/**/*.jsonl` with
//    `awaitWriteFinish` so we don't parse half-flushed lines, and
//    `ignoreInitial: true` so we don't re-fire `add` for the 3k files
//    we just reconciled.
//
// 3. **Debounced per-file reconcile** — a JSONL gets appended on every
//    turn. Without debouncing, a fast agent burst would queue dozens
//    of reconciles for the same file. Per-file 250ms debounce coalesces.
//
// 4. **Single-flight per file** — if a change event fires while the
//    debounced reconcile is mid-flight, schedule one more pass for after
//    completion. Prevents two transactions racing on the writer.
//
// 5. **30 s mtime sweep belt-and-braces** — chokidar can silently drop
//    events on WSL or network shares. The periodic sweep catches anything
//    the watcher missed. Cheap because the no-op gate skips unchanged
//    files immediately.
//
// 6. **Singleton on globalThis** — Next.js HMR will reload this module
//    on every dev save. The watcher must close cleanly before a new one
//    starts; otherwise chokidar handles leak.

const DEBOUNCE_MS = 250;
const SWEEP_INTERVAL_MS = 30_000;
const AWAIT_WRITE_FINISH_MS = 250;
// Cap on how long we'll wait for chokidar's initial scan. A malformed
// watch path or a permission issue can leave `ready` un-emitted; we
// don't want server boot to hang forever waiting on it. 30 s is well
// past any plausible scan time (the initial scan is metadata-only —
// chokidar isn't reading file contents).
const READY_TIMEOUT_MS = 30_000;

interface WatcherState {
  watcher: FSWatcher | null;
  projectsDir: string;
  /** Effective debounce window — production default or test override. */
  debounceMs: number;
  /** Per-file debounce timers. Keyed by absolute path. */
  pendingTimers: Map<string, NodeJS.Timeout>;
  /** Files currently being reconciled (single-flight gate). */
  inFlight: Set<string>;
  /**
   * Files whose reconcile finished but had a coalesced event waiting —
   * schedule one more pass.
   */
  needsAnotherPass: Set<string>;
  /**
   * True while the (possibly deferred) initial `reconcileAllSessions` is
   * running. Per-file reconciles and sweep ticks are held off while set —
   * a per-file tail-append racing the full sweep on the same session
   * could double-insert turn indices (the cursor read and the write txn
   * straddle awaits). Held-off work reschedules itself; nothing is lost.
   */
  initialReconcileInFlight: boolean;
  sweepTimer: NodeJS.Timeout | null;
  /**
   * True when the caller pinned an explicit projectsDir (tests, worker
   * wiring). When false, reconcile passes omit projectsDir so
   * `reconcileAllSessions` resolves ALL readable Claude homes (primary +
   * config.claudeHomes) each pass — the 30s sweep is what keeps extra
   * (e.g. WSL) homes ingested, since chokidar only watches the primary
   * tree (native fs events don't propagate over \\wsl.localhost).
   */
  explicitProjectsDir: boolean;
  /**
   * Set synchronously by `stopIngestWatcher()` (A2 graceful shutdown). Once
   * true, no new reconcile/sweep pass schedules or starts — checked at the top
   * of `scheduleReconcile`, `runReconcile`, and the sweep `tick`, and gating
   * the sweep re-arm — so a shutdown can't be chased by fresh index.db writes.
   */
  stopped: boolean;
  /**
   * In-flight ingest passes (initial reconcile, per-file reconciles, unlink
   * reconciles, sweeps). `stopIngestWatcher()` awaits these so SQLite isn't
   * closed mid-write; the wait is bounded by the shutdown deadline that the
   * lifecycle registry caps the disposer at.
   */
  activeWork: Set<Promise<void>>;
  /** Stats surfaced by `getWatcherStatus()` for debug surfaces. */
  startedAt: number;
  initialReconcileMs: number | null;
  eventsHandled: number;
  lastEventAt: number | null;
  errors: number;
}

const g = globalThis as unknown as {
  __minderIngestWatcher?: WatcherState;
};

function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export interface StartIngestWatcherOptions {
  /** Override the watch root. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /**
   * Bypass BOTH gates that would otherwise short-circuit
   * `startIngestWatcher`: an explicit `MINDER_INDEXER=0` opt-out AND
   * the `NODE_ENV === "test"` defense-in-depth. Tests pass this so a
   * watcher actually starts under vitest (where `NODE_ENV=test`) and
   * regardless of whatever `MINDER_INDEXER` value the host shell has
   * set. Production code paths must never set this — instrumentation
   * gates the test runtime upstream in `instrumentation.ts`.
   */
  bypassEnvFlag?: boolean;
  /** Suppress the 30 s sweep timer (tests don't want background timers). */
  disableSweep?: boolean;
  /**
   * Force chokidar polling mode. Default false. Some Windows fixtures
   * need polling to see changes inside `tmpdir()`; production uses
   * native FS events.
   */
  usePolling?: boolean;
  /**
   * Override the chokidar `awaitWriteFinish.stabilityThreshold`. Tests
   * use a shorter window (~50 ms) to keep the suite fast. Production
   * uses the longer default to avoid parsing half-flushed JSONL.
   */
  awaitWriteFinishMs?: number;
  /** Override the per-file debounce. Tests shorten this. */
  debounceMs?: number;
  /**
   * Run the initial `reconcileAllSessions` in the background instead of
   * blocking `startIngestWatcher` on it. The worker host passes this so
   * its `started` handshake acks as soon as the watcher is armed —
   * after a DERIVED_VERSION bump the initial reconcile is a full
   * re-parse of the corpus (minutes), and blocking on it used to blow
   * the host's 60 s start timeout, which then terminated a healthy
   * worker mid-write. Default false: the in-process path keeps its
   * reconcile-then-watch ordering.
   */
  deferInitialReconcile?: boolean;
  /**
   * Invoked once the (deferred or inline) initial reconcile settles.
   * The worker forwards this to the host as an `initial-reconcile`
   * message for observability.
   */
  onInitialReconcile?: (result: { ms: number; error?: string }) => void;
}

export interface WatcherStatus {
  running: boolean;
  projectsDir: string | null;
  startedAt: number | null;
  initialReconcileMs: number | null;
  eventsHandled: number;
  lastEventAt: number | null;
  errors: number;
  pending: number;
  inFlight: number;
}

/**
 * Start the ingest watcher. Idempotent — a second call closes the prior
 * watcher first. Returns the status snapshot. The watcher defaults on;
 * set `MINDER_INDEXER=0` to opt out. Returns a disabled status (without
 * starting) when EITHER (a) `MINDER_INDEXER=0`, OR (b) `NODE_ENV ===
 * "test"` — and `bypassEnvFlag` is unset. The vitest gate is a
 * defense-in-depth: tests that legitimately need a watcher pass
 * `bypassEnvFlag: true` and override both gates at once.
 */
export async function startIngestWatcher(
  options: StartIngestWatcherOptions = {}
): Promise<WatcherStatus> {
  if (!options.bypassEnvFlag && process.env.MINDER_INDEXER === "0") {
    return idleStatus();
  }
  // Vitest sets NODE_ENV=test; instrumentation.ts can be loaded in test
  // contexts unintentionally. Gate hard on that to avoid a stray watcher
  // racing against tests' tmpHome state.
  if (!options.bypassEnvFlag && process.env.NODE_ENV === "test") {
    return idleStatus();
  }

  await stopIngestWatcher();

  const projectsDir = options.projectsDir ?? defaultProjectsDir();

  // Make sure the DB is open and migrated before we start parsing.
  const init = await initDb();
  if (!init.available) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] DB unavailable (${init.error?.message ?? "unknown"}); watcher not started.`
    );
    return idleStatus();
  }

  const state: WatcherState = {
    watcher: null,
    projectsDir,
    debounceMs: options.debounceMs ?? DEBOUNCE_MS,
    pendingTimers: new Map(),
    inFlight: new Set(),
    needsAnotherPass: new Set(),
    initialReconcileInFlight: false,
    sweepTimer: null,
    explicitProjectsDir: options.projectsDir != null,
    stopped: false,
    activeWork: new Set(),
    startedAt: Date.now(),
    initialReconcileMs: null,
    eventsHandled: 0,
    lastEventAt: null,
    errors: 0,
  };
  g.__minderIngestWatcher = state;

  const runInitialReconcile = async (): Promise<void> => {
    const t0 = Date.now();
    let error: string | undefined;
    try {
      const db = await getDb();
      if (db) {
        await reconcileAllSessions(
          db,
          state.explicitProjectsDir ? { projectsDir } : {}
        );
      }
    } catch (err) {
      error = (err as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[ingest-watcher] initial reconcile failed: ${error}`);
      state.errors++;
    } finally {
      state.initialReconcileInFlight = false;
      state.initialReconcileMs = Date.now() - t0;
    }
    try {
      options.onInitialReconcile?.({ ms: state.initialReconcileMs, error });
    } catch {
      /* observer callback must not destabilize the watcher */
    }
  };

  if (options.deferInitialReconcile) {
    // Background mode: kick the reconcile NOW and keep going — chokidar is
    // imported and armed below while the pass runs. Any events chokidar
    // delivers before the pass completes hit the per-file guard in
    // `runReconcile` (and the sweep-tick guard), which reschedules them
    // until the flag clears — deferred, not dropped, and never reconciling
    // the same file concurrently with the full pass. Tracked so a shutdown
    // mid-reconcile drains it before closing SQLite.
    state.initialReconcileInFlight = true;
    void trackWork(state, runInitialReconcile());
  } else {
    // Inline mode (in-process watcher): reconcile-then-watch, no race
    // because chokidar hasn't started yet and `ignoreInitial: true` means
    // the `add` events for these files won't fire even after we attach.
    await trackWork(state, runInitialReconcile());
  }

  // Lazy import: `chokidar` ships with native binaries on some platforms
  // and is fine to skip in environments where it can't load. The runtime
  // is fully tolerant of it being absent (we just won't get incremental
  // events; the sweep still runs).
  let chokidar: typeof import("chokidar");
  try {
    chokidar = await import("chokidar");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] chokidar unavailable (${(err as Error).message}); falling back to sweep-only mode.`
    );
    if (!options.disableSweep) startSweep(state);
    return snapshot(state);
  }

  const stabilityThreshold = options.awaitWriteFinishMs ?? AWAIT_WRITE_FINISH_MS;
  // chokidar 4 dropped glob support — watch the directory directly and
  // filter non-`.jsonl` paths via the `ignored` callback. The watcher
  // surfaces directory create/delete events as a side effect; our event
  // handlers ignore everything that isn't a `.jsonl` file path.
  const watcher = chokidar.watch(projectsDir, {
    ignoreInitial: true,
    awaitWriteFinish:
      stabilityThreshold > 0
        ? {
            stabilityThreshold,
            pollInterval: Math.min(50, Math.max(10, Math.floor(stabilityThreshold / 4))),
          }
        : false,
    persistent: true,
    usePolling: options.usePolling ?? false,
    interval: options.usePolling ? 100 : 1000,
    binaryInterval: options.usePolling ? 100 : 3000,
  });

  state.watcher = watcher;

  // Attach the error listener BEFORE we await `ready`. Without it, an
  // EventEmitter `error` emission during the initial scan has no listener
  // and Node treats it as an uncaught error — crashing server boot.
  // We also need it wired up so the `ready` race below can reject on
  // startup failure instead of hanging forever.
  let pendingErrorReject: ((err: Error) => void) | null = null;
  watcher.on("error", (err) => {
    state.errors++;
    // eslint-disable-next-line no-console
    console.warn(`[ingest-watcher] chokidar error: ${(err as Error).message}`);
    if (pendingErrorReject) {
      pendingErrorReject(err as Error);
      pendingErrorReject = null;
    }
  });

  const onJsonl = (handler: (state: WatcherState, fp: string) => void) =>
    (filePath: string) => {
      if (!filePath.endsWith(".jsonl")) return;
      handler(state, filePath);
    };
  watcher.on("add", onJsonl(scheduleReconcile));
  watcher.on("change", onJsonl(scheduleReconcile));
  watcher.on("unlink", onJsonl(scheduleUnlink));

  // Don't return until the initial scan has completed. Race ready
  // against (a) an emitted error and (b) a 30 s timeout so a malformed
  // watch path can't block server boot indefinitely.
  try {
    await new Promise<void>((resolve, reject) => {
      pendingErrorReject = reject;
      const timeout = setTimeout(() => {
        pendingErrorReject = null;
        reject(new Error("chokidar ready timeout (30 s)"));
      }, READY_TIMEOUT_MS);
      timeout.unref?.();
      watcher.once("ready", () => {
        clearTimeout(timeout);
        pendingErrorReject = null;
        resolve();
      });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] failed to reach 'ready': ${(err as Error).message}. ` +
        `Falling back to sweep-only mode.`
    );
    try {
      await watcher.close();
    } catch {
      /* ignore */
    }
    state.watcher = null;
    if (!options.disableSweep) startSweep(state);
    return snapshot(state);
  }

  if (!options.disableSweep) startSweep(state);
  return snapshot(state);
}

/**
 * Close the current watcher, stop the sweep timer, and DRAIN any in-flight
 * reconcile/sweep before returning. Idempotent.
 *
 * The drain (A2 graceful shutdown, F7) matters because a `reconcileAllSessions`
 * or per-file `reconcileSessionFile` in flight is still writing to index.db;
 * returning before it settles would let the `sqlite` disposer close the DB
 * mid-write. `stopped` is set FIRST (synchronously) so no new pass schedules
 * or starts while we drain, then we await the tracked work. The await is
 * bounded upstream: the lifecycle registry caps the `ingest` disposer at the
 * shutdown deadline, so a multi-minute initial reconcile can't hang shutdown —
 * `stopped` has at least halted further writes by then.
 */
export async function stopIngestWatcher(): Promise<void> {
  const state = g.__minderIngestWatcher;
  if (!state) return;
  state.stopped = true; // synchronous: reconcile/sweep checkpoints bail now
  for (const t of state.pendingTimers.values()) clearTimeout(t);
  state.pendingTimers.clear();
  state.inFlight.clear();
  state.needsAnotherPass.clear();
  if (state.sweepTimer) {
    // Sweep is now self-scheduling setTimeout, not setInterval. The
    // re-arm guard in startSweep also gates on the singleton still
    // being us — `delete g.__minderIngestWatcher` below is the second
    // line of defense in case a tick is currently mid-flight.
    clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }
  if (state.watcher) {
    try {
      await state.watcher.close();
    } catch {
      /* swallow; we're tearing down */
    }
    state.watcher = null;
  }
  // Drain in-flight reconcile/sweep passes so SQLite isn't closed mid-write.
  if (state.activeWork.size > 0) {
    await Promise.allSettled([...state.activeWork]);
  }
  delete g.__minderIngestWatcher;
}

export function getWatcherStatus(): WatcherStatus {
  const state = g.__minderIngestWatcher;
  if (!state) return idleStatus();
  return snapshot(state);
}

function idleStatus(): WatcherStatus {
  return {
    running: false,
    projectsDir: null,
    startedAt: null,
    initialReconcileMs: null,
    eventsHandled: 0,
    lastEventAt: null,
    errors: 0,
    pending: 0,
    inFlight: 0,
  };
}

function snapshot(state: WatcherState): WatcherStatus {
  return {
    running: state.watcher !== null || state.sweepTimer !== null,
    projectsDir: state.projectsDir,
    startedAt: state.startedAt,
    initialReconcileMs: state.initialReconcileMs,
    eventsHandled: state.eventsHandled,
    lastEventAt: state.lastEventAt,
    errors: state.errors,
    pending: state.pendingTimers.size,
    inFlight: state.inFlight.size,
  };
}

/**
 * Register an in-flight ingest pass so `stopIngestWatcher()` can await it on
 * shutdown. Self-removes on settle. Returns the same promise for callers that
 * want to await it (the inline initial reconcile).
 */
function trackWork(state: WatcherState, p: Promise<void>): Promise<void> {
  state.activeWork.add(p);
  void p.finally(() => state.activeWork.delete(p));
  return p;
}

function scheduleReconcile(state: WatcherState, filePath: string): void {
  if (state.stopped) return; // shutting down — don't queue new reconciles
  state.lastEventAt = Date.now();
  // If a reconcile is in flight for this file, mark "needs another pass"
  // and let the in-flight one's completion handler reschedule us.
  if (state.inFlight.has(filePath)) {
    state.needsAnotherPass.add(filePath);
    return;
  }
  const existing = state.pendingTimers.get(filePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => { void trackWork(state, runReconcile(state, filePath)); }, state.debounceMs);
  state.pendingTimers.set(filePath, timer);
}

async function runReconcile(state: WatcherState, filePath: string): Promise<void> {
  state.pendingTimers.delete(filePath);
  if (state.stopped) return; // shutting down — don't start a new reconcile
  // Hold off while the deferred initial reconcile is still sweeping — a
  // per-file tail-append racing the full pass on the same session can
  // double-insert turn indices. Reschedule instead of dropping; the event
  // re-fires here until the flag clears.
  if (state.initialReconcileInFlight) {
    const timer = setTimeout(() => { void trackWork(state, runReconcile(state, filePath)); }, Math.max(state.debounceMs, 1_000));
    state.pendingTimers.set(filePath, timer);
    return;
  }
  state.inFlight.add(filePath);
  try {
    const db = getDbSync() ?? (await getDb());
    if (!db) {
      state.errors++;
      return;
    }
    const result = await reconcileSessionFile(db, filePath, projectDirNameFor(state.projectsDir, filePath));
    if (result.rowsWritten > 0) {
      refreshDailyCosts(db, result.affectedDays);
      // Sister rollup to daily_costs, keyed on category. Skipping it here
      // left category_costs stale for watcher-driven appends: the sweep
      // can't backfill because this reconcile already advanced the file's
      // cursor/mtime, so the next sweep sees the file as unchanged.
      refreshCategoryCosts(db, result.affectedCategoryTuples);
    }
    state.eventsHandled++;
  } catch (err) {
    state.errors++;
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] reconcile of ${filePath} failed: ${(err as Error).message}`
    );
  } finally {
    state.inFlight.delete(filePath);
    if (state.needsAnotherPass.delete(filePath)) {
      // A change event arrived while we were reconciling; re-schedule.
      scheduleReconcile(state, filePath);
    }
  }
}

/**
 * Handle a deleted JSONL. We re-run the full sweep's prune logic via a
 * lightweight `reconcileAllSessions` — the prune pass detects vanished
 * files and cleans up cascade-style. Rare event so the cost is fine.
 */
function scheduleUnlink(state: WatcherState, filePath: string): void {
  if (state.stopped) return; // shutting down — don't queue new reconciles
  state.lastEventAt = Date.now();
  const key = `__unlink__${filePath}`;
  const existing = state.pendingTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.pendingTimers.delete(key);
    if (state.stopped) return;
    void trackWork(state, (async () => {
      try {
        const db = getDbSync() ?? (await getDb());
        // Same contract as the initial/sweep reconciles: only pin projectsDir
        // when the caller explicitly supplied one. Pinning unconditionally
        // made the unlink-triggered prune treat ONLY the primary home's files
        // as live — one deleted local JSONL could purge every ingested
        // extra-home (WSL) session.
        if (db) {
          await reconcileAllSessions(
            db,
            state.explicitProjectsDir ? { projectsDir: state.projectsDir } : {}
          );
        }
        state.eventsHandled++;
      } catch (err) {
        state.errors++;
        // eslint-disable-next-line no-console
        console.warn(
          `[ingest-watcher] post-unlink reconcile failed: ${(err as Error).message}`
        );
      }
    })());
  }, state.debounceMs);
  state.pendingTimers.set(key, timer);
}

/**
 * Project dir name for a watched JSONL = the FIRST path segment under the
 * watch root, not the file's immediate parent. Chokidar watches the tree
 * recursively, and newer Claude Code nests subagent transcripts at
 * `<project>/<session-id>/subagents/agent-*.jsonl` — `basename(dirname(..))`
 * would misattribute those to a literal "subagents" project.
 * Exported for unit tests.
 */
export function projectDirNameFor(projectsDir: string, filePath: string): string {
  const rel = path.relative(projectsDir, filePath);
  const segments = rel.split(path.sep);
  if (!rel.startsWith("..") && !path.isAbsolute(rel) && segments.length >= 2) {
    return segments[0];
  }
  return path.basename(path.dirname(filePath));
}

function startSweep(state: WatcherState): void {
  // Self-scheduling setTimeout, NOT setInterval. Under a slow disk or a
  // very large project tree `reconcileAllSessions` could take longer
  // than `SWEEP_INTERVAL_MS`; setInterval would queue a second sweep
  // before the first finished, contending on the writer connection and
  // doubling the work. setTimeout-after-completion guarantees one sweep
  // at a time. `stopIngestWatcher` clears whichever phase is pending.
  const tick = async (): Promise<void> => {
    try {
      // Bail once shutting down — don't start a full reconcile that would
      // write to index.db while the shutdown disposer is closing it.
      if (state.stopped) return;
      // The deferred initial reconcile IS a full sweep; running a second
      // one concurrently would race it file-by-file. Skip this tick and
      // let the re-arm in `finally` pick up after it completes.
      if (state.initialReconcileInFlight) return;
      const db = getDbSync() ?? (await getDb());
      if (db) {
        await reconcileAllSessions(
          db,
          state.explicitProjectsDir ? { projectsDir: state.projectsDir } : {}
        );
      }
    } catch (err) {
      state.errors++;
      // eslint-disable-next-line no-console
      console.warn(`[ingest-watcher] sweep failed: ${(err as Error).message}`);
    } finally {
      // Re-arm only if we're still the active watcher AND not shutting down
      // (stopIngestWatcher sets `stopped` and detaches the singleton via
      // `delete g.__minderIngestWatcher`).
      if (!state.stopped && g.__minderIngestWatcher === state) {
        state.sweepTimer = setTimeout(() => { void trackWork(state, tick()); }, SWEEP_INTERVAL_MS);
        state.sweepTimer.unref?.();
      }
    }
  };
  state.sweepTimer = setTimeout(() => { void trackWork(state, tick()); }, SWEEP_INTERVAL_MS);
  state.sweepTimer.unref?.();
}
