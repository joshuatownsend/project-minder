/**
 * stdin control channel (C1) — graceful stop for console Node on Windows.
 *
 * A2 established that Windows cannot deliver a graceful stop signal to a
 * console Node process: `taskkill` *without* `/F` is refused for console apps,
 * and `taskkill /F` (or `SIGKILL`) terminates immediately, skipping every
 * disposer the lifecycle registry runs. The tray app (C1) supervises the
 * packaged server as a child process, so it needs an out-of-band way to ask
 * for a *clean* shutdown before it escalates to a hard process-tree kill.
 *
 * The channel is deliberately trivial: the supervisor writes a line to the
 * child's stdin (`shutdown\n`) — or closes the pipe (EOF) — and this listener
 * drives the SAME {@link shutdown} path the OS signal handlers use. The Rust
 * side then waits ~6s for the process to exit on its own and only `taskkill
 * /F /T`s the tree if that grace window elapses.
 *
 * ## Gating + safety
 *   - **Opt-in only** via `MINDER_CONTROL_STDIN=1`. Inert otherwise — a plain
 *     `pnpm dev` / `pnpm start` never captures stdin, so an interactive
 *     terminal keeps behaving normally. The tray always sets it for the
 *     children it spawns.
 *   - **Idempotent** (`globalThis` flag) so a dev/HMR re-fire of the boot path
 *     can't stack duplicate stdin listeners — the same house pattern the cache
 *     singletons and {@link installSignalHandlers} use.
 *   - **Never throws.** Any failure attaching the listener is logged and
 *     swallowed; a control channel that can crash the process it is trying to
 *     stop cleanly would defeat its own purpose.
 *   - Runs entirely inside service mode (the bootstrap gates demo mode out
 *     before it ever reaches here, and the caller skips it under vitest).
 */

import type { Readable } from "stream";
import { serviceLog } from "./serviceLog";

/** The one line the supervisor writes to request a clean shutdown. */
export const CONTROL_SHUTDOWN_COMMAND = "shutdown";

/**
 * Upper bound on an un-terminated (no-newline) line before it's discarded. The
 * only commands we accept are short (`shutdown`), so anything this long without
 * a newline is a malformed/hostile stream — drop it rather than let the buffer
 * grow without bound.
 */
export const MAX_LINE_BYTES = 256;

interface ControlChannelState {
  installed: boolean;
}

const g = globalThis as unknown as { __minderControlChannel?: ControlChannelState };
if (!g.__minderControlChannel) g.__minderControlChannel = { installed: false };
const state = g.__minderControlChannel;

/**
 * Pure gating decision — exported for unit testing. Takes an explicit env
 * object (defaulting to `process.env`) so tests don't mutate the real
 * environment. Only the exact string `"1"` enables the channel.
 */
export function shouldEnableControlChannel(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MINDER_CONTROL_STDIN === "1";
}

/** Test-only reset hook — mirrors `lifecycle.ts`'s `_resetLifecycleForTesting`. */
export function _resetControlChannelForTesting(): void {
  state.installed = false;
}

export interface ControlChannelHandlers {
  /** Invoked (at most once per distinct trigger) when a shutdown is requested. */
  onShutdownRequest: (reason: string) => void;
}

/**
 * Attach the line-oriented control protocol to an arbitrary readable stream.
 * Extracted from {@link initControlChannel} so the parsing — line buffering
 * across chunk boundaries, trimming, EOF handling — is unit-testable against a
 * mock stream without touching the real `process.stdin` or the shutdown path.
 *
 * Protocol: newline-delimited commands. A line equal to
 * {@link CONTROL_SHUTDOWN_COMMAND} (after trimming) requests shutdown; stream
 * `end` (the supervisor closing the pipe) also requests shutdown, so a killed
 * or detached supervisor still triggers a clean stop. Unknown lines are
 * ignored (logged at debug granularity by the caller, not here).
 */
export function attachControlChannel(stream: Readable, handlers: ControlChannelHandlers): void {
  let buffer = "";
  // utf8 so `data` chunks arrive as strings, not Buffers — matches how the
  // supervisor writes text lines. Guarded (`?.`) so a bare EventEmitter mock
  // without setEncoding still works in tests.
  stream.setEncoding?.("utf8");

  stream.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line === CONTROL_SHUTDOWN_COMMAND) {
        handlers.onShutdownRequest("control-stdin:shutdown");
      }
    }
    // Guard against an unbounded partial line: once what remains (no newline
    // yet) exceeds MAX_LINE_BYTES it can't be one of our short commands, so
    // discard it instead of letting a malformed stream grow the buffer forever.
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = "";
    }
  });

  // EOF — the supervisor closed our stdin. Treat as a shutdown request so we
  // still stop cleanly instead of lingering with orphaned watchers.
  stream.on("end", () => {
    handlers.onShutdownRequest("control-stdin:eof");
  });
}

/**
 * Drive the shared graceful-shutdown path, then exit. Guards on
 * {@link isShuttingDown} so a `shutdown` line followed by an EOF (or a signal
 * racing the stdin trigger) doesn't double-run — and {@link shutdown} itself
 * memoizes its in-flight run, so this is belt-and-suspenders. Never throws.
 */
async function triggerShutdown(reason: string): Promise<void> {
  try {
    const { shutdown, isShuttingDown } = await import("./lifecycle");
    if (isShuttingDown()) return;
    serviceLog({
      level: "info",
      subsystem: "control",
      msg: "shutdown requested via stdin control channel",
      reason,
    });
    await shutdown(reason);
  } catch (err) {
    serviceLog({
      level: "error",
      subsystem: "control",
      msg: "control-channel shutdown failed",
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Match the OS signal handlers' contract: exit 0 once disposers have run.
    process.exit(0);
  }
}

/**
 * Install the stdin control channel if `MINDER_CONTROL_STDIN=1`. Idempotent
 * and inert when the env var is unset. Called from the service-mode boot path
 * (never under vitest). `process.stdin.resume()` is required or a paused stdin
 * never emits `data`/`end`.
 */
export function initControlChannel(): void {
  if (!shouldEnableControlChannel()) return;
  if (state.installed) return;
  state.installed = true;

  try {
    const stdin = process.stdin;
    attachControlChannel(stdin, {
      onShutdownRequest: (reason) => {
        void triggerShutdown(reason);
      },
    });
    // A paused stream emits neither `data` nor `end`; resume so the supervisor's
    // writes and pipe-close actually reach us.
    stdin.resume?.();
    serviceLog({
      level: "info",
      subsystem: "control",
      msg: "stdin control channel active (MINDER_CONTROL_STDIN=1)",
    });
  } catch (err) {
    // Attaching failed (no stdin, exotic host) — stay inert rather than crash.
    state.installed = false;
    serviceLog({
      level: "warn",
      subsystem: "control",
      msg: "failed to attach stdin control channel",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
