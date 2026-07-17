/**
 * Process lifecycle / graceful-shutdown registry (A2).
 *
 * A tiny disposer registry so the service-mode server can be *supervised*:
 * stopped cleanly on a signal, releasing every `fs.watch` handle, timer, child
 * process, and the SQLite connection instead of being hard-killed with WAL
 * files mid-flight. The tray app (C1) and the OS autostart wrappers (A3) both
 * stop the server by sending it a signal; this is what makes that stop clean.
 *
 * ## Ordering — LIFO (reverse registration)
 *
 * Disposers run in the reverse of the order they were registered, the same
 * discipline as a destructor stack: later subsystems are the ones that may
 * depend on earlier ones, so they must come down first. Concretely the
 * bootstrap registers the SQLite close FIRST (so it disposes LAST) and the
 * watchers/caches/dispatcher AFTER (so their timers and `fs.watch` handles are
 * torn down BEFORE the DB handle they might still write through is closed).
 *
 * ## Isolation + timeout
 *
 * Each disposer is awaited inside its own try/catch, so one that throws or
 * hangs never blocks the rest — the failure is logged and the next disposer
 * runs. The whole sequence shares a hard overall deadline (~5 s): each disposer
 * is raced against the time remaining, and once the budget is spent the
 * stragglers are logged as skipped rather than awaited forever. This bounds
 * shutdown latency so a supervisor's kill-timeout never has to escalate to
 * SIGKILL for a well-behaved server.
 *
 * ## Crash semantics (deliberately unchanged)
 *
 * Only `SIGINT` / `SIGTERM` / `SIGBREAK` (Windows) are wired. `uncaughtException`
 * and `unhandledRejection` are intentionally NOT handled here: installing a
 * handler for them would suppress Node's default crash-and-exit behavior, which
 * would change existing semantics (the plan explicitly gates that on "only if
 * you can do it without changing crash semantics" — you can't, cleanly). A
 * crash should still crash; this module governs orderly, signalled shutdown.
 *
 * Registration and handler-install are both idempotent (`globalThis` guards +
 * dedupe-by-name) so a dev/HMR re-fire can't stack duplicate handlers.
 */

import { serviceLog } from "./serviceLog";

export type DisposerFn = () => void | Promise<void>;

interface LifecycleState {
  /** Insertion-ordered; keyed by name so re-registration replaces in place. */
  disposers: Map<string, DisposerFn>;
  shuttingDown: boolean;
  handlersInstalled: boolean;
}

const g = globalThis as unknown as { __minderLifecycle?: LifecycleState };
if (!g.__minderLifecycle) {
  g.__minderLifecycle = {
    disposers: new Map(),
    shuttingDown: false,
    handlersInstalled: false,
  };
}
const state = g.__minderLifecycle;

/** Hard ceiling on the whole shutdown sequence. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Register a named disposer. Idempotent by name: registering the same name
 * again replaces the function without adding a second entry or changing its
 * position in the LIFO order (survives HMR re-runs of the bootstrap).
 */
export function onShutdown(name: string, fn: DisposerFn): void {
  state.disposers.set(name, fn);
}

export function registeredDisposerCount(): number {
  return state.disposers.size;
}

export function isShuttingDown(): boolean {
  return state.shuttingDown;
}

/** Test-only reset hook. */
export function _resetLifecycleForTesting(): void {
  state.disposers.clear();
  state.shuttingDown = false;
  state.handlersInstalled = false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run every registered disposer (LIFO) under a shared overall deadline,
 * logging one structured line per disposer (name, ok/fail, ms). Idempotent:
 * a second call (e.g. a double Ctrl+C, or a signal arriving mid-shutdown)
 * returns immediately. Never throws.
 */
export async function shutdown(
  reason: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  const overallMs = opts?.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const deadline = Date.now() + overallMs;

  serviceLog({
    level: "info",
    subsystem: "lifecycle",
    msg: "shutdown initiated",
    reason,
    disposers: state.disposers.size,
    timeoutMs: overallMs,
  });

  // LIFO: reverse of registration order.
  const entries = [...state.disposers.entries()].reverse();
  for (const [name, fn] of entries) {
    const remaining = deadline - Date.now();
    const start = Date.now();

    if (remaining <= 0) {
      serviceLog({
        level: "warn",
        subsystem: "lifecycle",
        msg: "disposer skipped (shutdown budget exhausted)",
        disposer: name,
        ok: false,
        ms: 0,
      });
      continue;
    }

    try {
      await withTimeout(Promise.resolve().then(fn), remaining);
      serviceLog({
        level: "info",
        subsystem: "lifecycle",
        msg: "disposer ok",
        disposer: name,
        ok: true,
        ms: Date.now() - start,
      });
    } catch (err) {
      serviceLog({
        level: "error",
        subsystem: "lifecycle",
        msg: "disposer failed",
        disposer: name,
        ok: false,
        ms: Date.now() - start,
        error: (err as Error).message,
      });
    }
  }

  serviceLog({
    level: "info",
    subsystem: "lifecycle",
    msg: "shutdown complete",
    reason,
  });
}

/**
 * Wire OS signal handlers to {@link shutdown}. Idempotent — a second call is a
 * no-op, so dev/HMR re-runs never stack duplicate listeners.
 *
 * `SIGBREAK` only ever fires on Windows (Ctrl+Break); registering it elsewhere
 * is harmless (the listener simply never runs). When `exit` is true (the
 * default) the process exits 0 after disposers finish; tests pass `exit: false`
 * to drive `shutdown()` without tearing down the test runner.
 */
export function installSignalHandlers(opts?: { exit?: boolean }): void {
  if (state.handlersInstalled) return;
  state.handlersInstalled = true;

  const exit = opts?.exit ?? true;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK"];

  for (const sig of signals) {
    process.on(sig, () => {
      void shutdown(sig).finally(() => {
        if (exit) process.exit(0);
      });
    });
  }

  serviceLog({
    level: "info",
    subsystem: "lifecycle",
    msg: "signal handlers installed",
    signals,
  });
}
