import "server-only";
import path from "path";
import os from "os";
import type { FSWatcher } from "chokidar";
import { initDb } from "./migrations";
import {
  reconcileAllSessions,
  reconcileSessionFile,
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
  sweepTimer: NodeJS.Timeout | null;
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
    sweepTimer: null,
    startedAt: Date.now(),
    initialReconcileMs: null,
    eventsHandled: 0,
    lastEventAt: null,
    errors: 0,
  };
  g.__minderIngestWatcher = state;

  // Initial reconcile (synchronous-feeling — no race because the watcher
  // hasn't started yet; chokidar's `ignoreInitial: true` means the `add`
  // events for these files won't fire even after we attach).
  const t0 = Date.now();
  try {
    const db = await getDb();
    if (db) await reconcileAllSessions(db, { projectsDir });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest-watcher] initial reconcile failed: ${(err as Error).message}`
    );
    state.errors++;
  }
  state.initialReconcileMs = Date.now() - t0;

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
 * Close the current watcher and stop the sweep timer. Idempotent.
 */
export async function stopIngestWatcher(): Promise<void> {
  const state = g.__minderIngestWatcher;
  if (!state) return;
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

function scheduleReconcile(state: WatcherState, filePath: string): void {
  state.lastEventAt = Date.now();
  // If a reconcile is in flight for this file, mark "needs another pass"
  // and let the in-flight one's completion handler reschedule us.
  if (state.inFlight.has(filePath)) {
    state.needsAnotherPass.add(filePath);
    return;
  }
  const existing = state.pendingTimers.get(filePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => runReconcile(state, filePath), state.debounceMs);
  state.pendingTimers.set(filePath, timer);
}

async function runReconcile(state: WatcherState, filePath: string): Promise<void> {
  state.pendingTimers.delete(filePath);
  state.inFlight.add(filePath);
  try {
    const db = getDbSync() ?? (await getDb());
    if (!db) {
      state.errors++;
      return;
    }
    const projectDirName = path.basename(path.dirname(filePath));
    const result = await reconcileSessionFile(db, filePath, projectDirName);
    if (result.rowsWritten > 0) {
      refreshDailyCosts(db, result.affectedDays);
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
  state.lastEventAt = Date.now();
  const key = `__unlink__${filePath}`;
  const existing = state.pendingTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    state.pendingTimers.delete(key);
    try {
      const db = getDbSync() ?? (await getDb());
      if (db) await reconcileAllSessions(db, { projectsDir: state.projectsDir });
      state.eventsHandled++;
    } catch (err) {
      state.errors++;
      // eslint-disable-next-line no-console
      console.warn(
        `[ingest-watcher] post-unlink reconcile failed: ${(err as Error).message}`
      );
    }
  }, state.debounceMs);
  state.pendingTimers.set(key, timer);
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
      const db = getDbSync() ?? (await getDb());
      if (db) await reconcileAllSessions(db, { projectsDir: state.projectsDir });
    } catch (err) {
      state.errors++;
      // eslint-disable-next-line no-console
      console.warn(`[ingest-watcher] sweep failed: ${(err as Error).message}`);
    } finally {
      // Re-arm only if we're still the active watcher (stopIngestWatcher
      // detaches the singleton via `delete g.__minderIngestWatcher`).
      if (g.__minderIngestWatcher === state) {
        state.sweepTimer = setTimeout(tick, SWEEP_INTERVAL_MS);
        state.sweepTimer.unref?.();
      }
    }
  };
  state.sweepTimer = setTimeout(tick, SWEEP_INTERVAL_MS);
  state.sweepTimer.unref?.();
}
