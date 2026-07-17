/**
 * Service-mode file logger (A2).
 *
 * Appends structured JSON-lines to `~/.minder/logs/minder.log`, size-rotated
 * (5 MB × 3 rotated files). Used by the boot-time bootstrap (A1) and the
 * shutdown lifecycle (A2) so a headless / tray-supervised server leaves a
 * durable trace of what it started and how it stopped — the thing you read
 * when the tray app says "degraded" and there's no attached terminal.
 *
 * Design notes:
 *   - **Only writes a file when {@link initServiceLog} has been called** — i.e.
 *     when the bootstrap ran (service mode). In plain `pnpm dev` (no bootstrap)
 *     every call still tees to the console but never touches the filesystem, so
 *     the dev edit-loop behaves exactly as before and unit tests don't spray
 *     files into `~/.minder`.
 *   - **Never throws.** A logger that can crash the process it's observing is
 *     worse than useless; every fs touch is wrapped and swallowed.
 *   - **No new dependencies** — hand-rolled rotation over `fs`, matching the
 *     "filesystem is the database" ethos of the rest of the codebase.
 *   - **`globalThis` singleton state** so the active flag survives Next.js HMR
 *     module reloads (the house pattern used by every cache singleton here).
 */

import * as fs from "fs";
import os from "os";
import path from "path";

export const LOG_DIR = path.join(os.homedir(), ".minder", "logs");
export const LOG_FILE = path.join(LOG_DIR, "minder.log");

/** Rotate when the active log would exceed this many bytes. */
export const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
/** Number of rotated files kept: minder.log.1 … minder.log.3 (plus the live minder.log). */
export const MAX_FILES = 3;

interface ServiceLogState {
  active: boolean;
  /**
   * Running byte size of the live log file, maintained in memory so the
   * write path doesn't statSync on every line (an extra blocking syscall
   * per log call, ~10 of which sit directly in the boot sequence).
   * Seeded from one statSync in {@link initServiceLog}; incremented per
   * append; reset on rotation. If something external truncates/deletes the
   * file mid-run the counter is stale by at most one rotation cycle —
   * acceptable for a best-effort log ring.
   */
  bytes: number;
}

const g = globalThis as unknown as { __minderServiceLog?: ServiceLogState };
if (!g.__minderServiceLog) g.__minderServiceLog = { active: false, bytes: 0 };
const state = g.__minderServiceLog;

/** Turn on file logging (called by the bootstrap when it runs). Idempotent. */
export function initServiceLog(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* dir creation best-effort — serviceLog() still tees to console */
  }
  try {
    state.bytes = fs.statSync(LOG_FILE).size;
  } catch {
    state.bytes = 0; // no existing file
  }
  state.active = true;
}

export function isServiceLogActive(): boolean {
  return state.active;
}

/** Test-only reset hook — mirrors `bootstrap.ts`'s `_resetBootstrapForTesting`. */
export function _resetServiceLogForTesting(): void {
  state.active = false;
  state.bytes = 0;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level?: LogLevel;
  subsystem?: string;
  msg: string;
  [key: string]: unknown;
}

/**
 * Pure rotation predicate — extracted so the rotation math is unit-testable
 * without touching the filesystem. Returns true when appending `incomingBytes`
 * to a file already holding `currentBytes` would push it past `maxBytes`. A
 * zero-length (or missing) file never rotates, so a single oversized line can
 * still be written rather than looping forever.
 */
export function shouldRotate(
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number = MAX_BYTES,
): boolean {
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
}

/**
 * Rotate the log ring: drop `<file>.<maxFiles>`, then shift each
 * `<file>.<n>` → `<file>.<n+1>` down to `<file>` → `<file>.1`. Every fs call
 * is guarded so a locked/racing rename can't abort the shift or throw into the
 * caller. `fsMod` is injectable purely to keep the rename ORDER assertable in
 * tests; production always uses the module's own `fs`.
 */
export function rotateLogs(
  file: string = LOG_FILE,
  maxFiles: number = MAX_FILES,
  fsMod: typeof fs = fs,
): void {
  const oldest = `${file}.${maxFiles}`;
  try {
    if (fsMod.existsSync(oldest)) fsMod.rmSync(oldest, { force: true });
  } catch {
    /* ignore */
  }
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    const dst = `${file}.${i + 1}`;
    try {
      if (fsMod.existsSync(src)) fsMod.renameSync(src, dst);
    } catch {
      /* ignore */
    }
  }
  try {
    if (fsMod.existsSync(file)) fsMod.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

/**
 * Emit one structured log line. Always tees to the console (warn/error via
 * `console.warn`, else `console.log`); additionally appends to the rotated
 * file when {@link initServiceLog} has been called. Never throws.
 */
export function serviceLog(entry: LogEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  const level = entry.level ?? "info";

  // Console tee — happens in every mode so dev/CI still see the lines.
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  if (!state.active) return;

  try {
    const incoming = Buffer.byteLength(line) + 1; // + newline
    if (shouldRotate(state.bytes, incoming)) {
      rotateLogs();
      state.bytes = 0;
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
    state.bytes += incoming;
  } catch {
    /* file logging is best-effort; the console tee already fired */
  }
}
