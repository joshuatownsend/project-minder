import "server-only";
import path from "path";
import { Worker } from "node:worker_threads";

// Main-thread orchestrator for the ingest worker.
//
// Why a worker at all:
//   1. Crash isolation — if SQLite or chokidar throws fatally, the HTTP
//      server stays up and the dashboard's file-parse fallback keeps
//      working.
//   2. Cold-boot UX — the initial reconcile (3k JSONLs, ~30 s on first
//      boot) no longer blocks the Next.js instrumentation hook from
//      returning.
//   3. Foundation for the SSE event bus in P3 — the worker emits
//      events, the main thread fans them out to subscribers.
//
// Why a sibling .mjs at workers/ instead of a TS file under src/:
//   Next.js / Turbopack bundles everything under src/ and app/, but
//   leaves arbitrary root directories alone. `workers/` is a plain
//   project directory that Node loads directly via `new Worker()`.
//   Resolving via `process.cwd()` works in both `next dev` (cwd is
//   the project root) and `next start` (same), and avoids the
//   `import.meta.url` portability mess. (We do NOT support running
//   under a `cd` to a subdirectory; the dev script anchors to the
//   project root.)

const WORKER_REL_PATH = path.join("workers", "ingestWorker.mjs");
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const CRASH_RESPAWN_BACKOFF_MS = [500, 2_000, 10_000];
const MAX_RESPAWNS_PER_HOUR = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;

type MessageSubscriber = (msg: unknown) => void;

interface WorkerHostState {
  worker: Worker | null;
  /** Resolved worker-entry path, set at spawn time. Surfaced via getWorkerStatus. */
  workerEntry: string;
  startedAt: number | null;
  lastReadyAt: number | null;
  lastMessageAt: number | null;
  /** Recent crash timestamps (ms). Pruned to the last hour on read + write. */
  crashHistory: number[];
  respawnTimer: NodeJS.Timeout | null;
  /** Set true once stopWorker is called; suppresses respawn. */
  stopping: boolean;
  /**
   * Resolves once the worker emits its `ready` message. `startWorker`
   * awaits this so callers see a settled handle.
   */
  readyPromise: Promise<void> | null;
  /**
   * Owned by state (not the spawn closure) so `stopWorker` can clear
   * the timeout and reject a pending await — otherwise a stop-during-
   * startup hangs the full ready timeout.
   */
  readyTimeout: NodeJS.Timeout | null;
  readyResolve: (() => void) | null;
  readyReject: ((err: Error) => void) | null;
  /**
   * Subscriber registry on state, NOT on the Worker instance, so
   * subscriptions survive crash-respawn. A single internal listener
   * per spawn fans out to all subscribers.
   */
  messageSubscribers: Set<MessageSubscriber>;
  readyTimeoutMs: number;
}

const g = globalThis as unknown as { __minderWorker?: WorkerHostState };

function freshState(readyTimeoutMs: number, workerEntry: string): WorkerHostState {
  return {
    worker: null,
    workerEntry,
    startedAt: null,
    lastReadyAt: null,
    lastMessageAt: null,
    crashHistory: [],
    respawnTimer: null,
    stopping: false,
    readyPromise: null,
    readyTimeout: null,
    readyResolve: null,
    readyReject: null,
    messageSubscribers: new Set(),
    readyTimeoutMs,
  };
}

function pruneCrashHistory(state: WorkerHostState): number {
  const cutoff = Date.now() - ONE_HOUR_MS;
  state.crashHistory = state.crashHistory.filter((t) => t >= cutoff);
  return state.crashHistory.length;
}

export interface WorkerHostStatus {
  running: boolean;
  startedAt: number | null;
  lastReadyAt: number | null;
  lastMessageAt: number | null;
  crashesLastHour: number;
  workerEntry: string;
}

export interface StartWorkerOptions {
  /**
   * Absolute path to the worker entry. Defaults to
   * `<cwd>/workers/ingestWorker.mjs`. Tests override this to point at
   * fixture workers.
   */
  workerEntry?: string;
  /**
   * Override the ready timeout. Default 10 s. Tests pass a short value
   * (~500 ms) to keep suite runtime down on the timeout-rejection path.
   */
  readyTimeoutMs?: number;
}

/**
 * Spawn the ingest worker. Idempotent — a second call terminates the
 * prior worker first. Resolves once the worker has emitted its `ready`
 * message (or rejects on a startup-time crash / timeout).
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerHostStatus> {
  await stopWorker();

  const entry = options.workerEntry ?? path.join(process.cwd(), WORKER_REL_PATH);
  const state = freshState(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, entry);
  g.__minderWorker = state;

  spawnAndAttach(state, entry);

  await state.readyPromise;
  return snapshot(state);
}

/**
 * Terminate the worker if running. Suppresses crash-respawn. Idempotent.
 * Rejects any pending readyPromise so a stop-during-startup unblocks
 * the awaiting caller immediately.
 */
export async function stopWorker(): Promise<void> {
  const state = g.__minderWorker;
  if (!state) return;
  state.stopping = true;
  if (state.respawnTimer) {
    clearTimeout(state.respawnTimer);
    state.respawnTimer = null;
  }
  if (state.readyTimeout) {
    clearTimeout(state.readyTimeout);
    state.readyTimeout = null;
  }
  if (state.readyReject) {
    state.readyReject(new Error("worker stopped before ready"));
    state.readyReject = null;
    state.readyResolve = null;
  }
  state.messageSubscribers.clear();
  if (state.worker) {
    try {
      state.worker.postMessage({ type: "stop" });
    } catch {
      /* worker may already be dead; fall through to terminate */
    }
    try {
      await state.worker.terminate();
    } catch {
      /* swallow */
    }
    state.worker = null;
  }
  delete g.__minderWorker;
}

export function getWorkerStatus(): WorkerHostStatus {
  const state = g.__minderWorker;
  if (!state) {
    return {
      running: false,
      startedAt: null,
      lastReadyAt: null,
      lastMessageAt: null,
      crashesLastHour: 0,
      workerEntry: "",
    };
  }
  return snapshot(state);
}

export function postMessage(message: unknown): boolean {
  const state = g.__minderWorker;
  if (!state || !state.worker) return false;
  try {
    state.worker.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to messages from the worker. Returns an unsubscribe fn.
 * Subscription is held on the host state, not on a specific Worker
 * instance, so it survives crash-respawn.
 */
export function onWorkerMessage(handler: MessageSubscriber): () => void {
  const state = g.__minderWorker;
  if (!state) return () => {};
  state.messageSubscribers.add(handler);
  return () => {
    state.messageSubscribers.delete(handler);
  };
}

function snapshot(state: WorkerHostState): WorkerHostStatus {
  return {
    running: state.worker !== null,
    startedAt: state.startedAt,
    lastReadyAt: state.lastReadyAt,
    lastMessageAt: state.lastMessageAt,
    crashesLastHour: pruneCrashHistory(state),
    workerEntry: state.workerEntry,
  };
}

function spawnAndAttach(state: WorkerHostState, entry: string): void {
  const worker = new Worker(entry, { stderr: false, stdout: false });
  state.worker = worker;
  state.startedAt = Date.now();

  state.readyPromise = new Promise<void>((resolve, reject) => {
    state.readyResolve = resolve;
    state.readyReject = reject;
  });
  // Initial start awaits readyPromise; respawns don't. Attach a silent
  // catch so a stopWorker-induced rejection on the respawn path doesn't
  // surface as an unhandled rejection. The `await` in startWorker still
  // sees the rejection because await registers its own handler.
  state.readyPromise.catch(() => {});

  state.readyTimeout = setTimeout(() => {
    if (state.readyReject) {
      state.readyReject(new Error(`worker ready timeout (${state.readyTimeoutMs} ms)`));
      state.readyReject = null;
      state.readyResolve = null;
    }
    state.readyTimeout = null;
    void worker.terminate().catch(() => {});
  }, state.readyTimeoutMs);
  state.readyTimeout.unref?.();

  worker.on("message", (msg: unknown) => {
    state.lastMessageAt = Date.now();
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "ready") {
      state.lastReadyAt = Date.now();
      if (state.readyTimeout) {
        clearTimeout(state.readyTimeout);
        state.readyTimeout = null;
      }
      if (state.readyResolve) {
        state.readyResolve();
        state.readyResolve = null;
        state.readyReject = null;
      }
    }
    // Fan out to host-level subscribers. One handler throwing must not
    // starve the others or kill the listener.
    for (const sub of state.messageSubscribers) {
      try {
        sub(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[ingest-worker] subscriber threw: ${(err as Error).message}`);
      }
    }
  });

  worker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[ingest-worker] error: ${err.message}`);
    if (state.readyTimeout) {
      clearTimeout(state.readyTimeout);
      state.readyTimeout = null;
    }
    if (state.readyReject) {
      state.readyReject(err);
      state.readyReject = null;
      state.readyResolve = null;
    }
  });

  worker.on("exit", (code) => {
    // Only treat unexpected exits as crashes — `stopWorker()` flips the
    // flag before terminate(), and clean shutdowns (worker calls
    // `process.exit(0)` after a `stop` message) exit with code 0.
    if (state.readyTimeout) {
      clearTimeout(state.readyTimeout);
      state.readyTimeout = null;
    }
    // If the worker exits before emitting `ready` (e.g. process.exit
    // without an `error` event), nothing else will ever settle the
    // pending readyPromise — the awaiting `startWorker` would hang.
    // Reject here so the caller sees a clean failure.
    if (state.readyReject) {
      state.readyReject(new Error(`worker exited (code ${code}) before ready`));
      state.readyReject = null;
      state.readyResolve = null;
    }
    if (state.stopping) return;
    if (code === 0) return;
    if (g.__minderWorker !== state) return;

    state.crashHistory.push(Date.now());
    const crashes = pruneCrashHistory(state);
    // eslint-disable-next-line no-console
    console.warn(`[ingest-worker] exited with code ${code}; scheduling respawn (${crashes} crashes in last hour)`);

    if (crashes >= MAX_RESPAWNS_PER_HOUR) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ingest-worker] crash budget exceeded (${crashes}/${MAX_RESPAWNS_PER_HOUR} in last hour); ` +
          `giving up. Restart the dev server to resume ingest.`
      );
      state.worker = null;
      return;
    }

    const backoffIdx = Math.min(crashes - 1, CRASH_RESPAWN_BACKOFF_MS.length - 1);
    const backoff = CRASH_RESPAWN_BACKOFF_MS[backoffIdx];
    state.worker = null;
    state.respawnTimer = setTimeout(() => {
      state.respawnTimer = null;
      if (state.stopping || g.__minderWorker !== state) return;
      spawnAndAttach(state, entry);
    }, backoff);
    state.respawnTimer.unref?.();
  });
}
