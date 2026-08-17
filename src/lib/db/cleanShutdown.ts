import "server-only";
import path from "path";
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "fs";

// Clean-shutdown marker for the SQLite index.
//
// WHY THIS EXISTS
//
// `initDb()` runs `PRAGMA quick_check` on every open (migrations.ts, "Path 2").
// quick_check is O(database size) and better-sqlite3 is synchronous, so on a
// large index it blocks the Node event loop outright — no HTTP request is
// served for its whole duration, `/api/health` included. Measured on a real
// 2.1 GB `index.db` after a reboot (cold page cache): **2m 47s**, against 74 ms
// for the same call on a warm restart. During that window the tray's 4 s health
// probe times out, and the dashboard is simply unreachable.
//
// The check still earns its keep after an *unclean* stop — that's when a
// derived index actually gets torn. After a *graceful* stop we already
// checkpointed the WAL and closed the handle ourselves, so re-verifying every
// page on the next boot buys almost nothing at a cost that grows without bound
// as the index does.
//
// THE TRUST PROTOCOL
//
// On a graceful close we record `{ size, mtimeMs }` of the main DB file. On the
// next open we trust that marker only if BOTH still hold:
//
//   1. The main DB file's size and mtime are byte-identical to what we recorded.
//      Any write since the clean close moves at least one of them.
//   2. The `-wal` sidecar is absent or zero-length. A non-empty WAL is direct
//      evidence of an unclean stop — the graceful path truncates it — and it is
//      an independent signal, so a marker alone can never certify "clean".
//
// Deliberately NOT consume-on-read. The marker is invalidated by the DB
// changing underneath it, not by someone having looked at it. That matters
// because two processes open this DB at boot — the server and the ingest worker
// (`workers/ingestWorker`, a separate process with its own connection). Under
// consume-on-read, whichever opened first would take the fast path and the
// other would still pay the full multi-minute scan, thrashing the disk at boot
// for no added safety.
//
// The residual risk is corruption that arrives without touching size, mtime, or
// the WAL — a bad sector, or an external process editing the file in place.
// `QUICK_CHECK_ALWAYS_MAX_BYTES` covers the common case by keeping the check
// unconditional while it is cheap, and `MINDER_FORCE_QUICK_CHECK=1` forces a
// full scan on demand for support.

/** Marker schema version — bump if the shape below changes meaning. */
const MARKER_VERSION = 1;

/**
 * Below this size, `quick_check` runs on EVERY open regardless of the marker.
 * The scan is milliseconds at this scale, so skipping it would trade real
 * corruption detection for no measurable gain. 256 MB is well above a typical
 * index and well below the size at which the stall becomes user-visible.
 */
export const QUICK_CHECK_ALWAYS_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The effective threshold, with `MINDER_QUICK_CHECK_MAX_BYTES` as an override.
 *
 * Exists so the skip branch is *reachable in a test*. With a hardcoded 256 MB
 * constant, the only code path that will ever run on a real multi-gigabyte index
 * could not be exercised without fabricating one — leaving the production
 * behavior verified solely by argument. The seam that needs real coverage is
 * temporal, not logical: the marker stats the DB file after `closeDb()`, while
 * the next open runs SQLite's own pragmas *before* the marker is read, so if any
 * of them touched mtime or left a non-empty WAL the marker would silently never
 * validate. That failure is safe (we just run the check) but total, and no
 * amount of pure-function testing can see it.
 *
 * Also a support lever: lowering it forces the fast path on, raising it forces
 * the check back on for every index.
 */
export function quickCheckAlwaysMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MINDER_QUICK_CHECK_MAX_BYTES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : QUICK_CHECK_ALWAYS_MAX_BYTES;
}

export interface CleanShutdownMarker {
  version: number;
  closedAt: string;
  /** Size of the main DB file at clean close, in bytes. */
  dbSize: number;
  /** mtime of the main DB file at clean close, in epoch ms. */
  dbMtimeMs: number;
}

/** Why the marker was (not) trusted — surfaced in logs, never user-facing. */
export type CleanShutdownReason =
  | "trusted"
  | "no-marker"
  | "unreadable-marker"
  | "version-mismatch"
  | "db-changed"
  | "wal-not-empty"
  | "db-missing";

export interface CleanShutdownState {
  trusted: boolean;
  reason: CleanShutdownReason;
}

/**
 * Sidecar path for a given DB path. Kept next to the DB (not in a temp dir) so
 * it travels with the index rather than with a machine's scratch space.
 *
 * Note it is NOT swept up automatically by the quarantine rename, which moves
 * `index.db` and its `-wal`/`-shm` siblings and nothing else — `quarantineCorruptDb`
 * calls `clearCleanShutdownMarker` explicitly for exactly that reason.
 */
export function markerPathFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.clean`);
}

function walPathFor(dbPath: string): string {
  return `${dbPath}-wal`;
}

/** True when the `-wal` sidecar is absent or zero-length. */
function walIsDrained(dbPath: string): boolean {
  try {
    const wal = walPathFor(dbPath);
    if (!existsSync(wal)) return true;
    return statSync(wal).size === 0;
  } catch {
    // Can't tell — treat as NOT drained. Failing toward the full check is the
    // safe direction: the cost is time, the alternative risks serving corruption.
    return false;
  }
}

/**
 * Record a clean shutdown. Call only AFTER a WAL checkpoint has been verified
 * to have drained — writing this after a failed checkpoint would falsely
 * certify a dirty database as clean.
 *
 * Never throws: a marker we couldn't write simply means the next boot runs the
 * full check, which is the pre-existing behavior.
 *
 * @returns true if the marker was written.
 */
export function writeCleanShutdownMarker(dbPath: string): boolean {
  try {
    if (!existsSync(dbPath)) return false;
    // Re-stat AFTER the checkpoint so the recorded size/mtime describe the
    // post-checkpoint file, which is what the next open will see.
    const st = statSync(dbPath);
    const marker: CleanShutdownMarker = {
      version: MARKER_VERSION,
      closedAt: new Date().toISOString(),
      dbSize: st.size,
      dbMtimeMs: st.mtimeMs,
    };
    writeFileSync(markerPathFor(dbPath), JSON.stringify(marker), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove any existing marker, so a rebuilt index cannot inherit the previous
 * file's claim to a clean shutdown.
 *
 * The quarantine path in `migrations.ts` is the only production caller, and
 * that is by design rather than an oversight: ordinary writes do not need to
 * clear the marker, because the size+mtime binding in
 * `readCleanShutdownState` already invalidates it the moment the file changes.
 * Quarantine is the exception — it *replaces* the file, so the binding would
 * otherwise be compared against a different database entirely.
 */
export function clearCleanShutdownMarker(dbPath: string): void {
  try {
    unlinkSync(markerPathFor(dbPath));
  } catch {
    /* absent or unremovable — the size/mtime binding still invalidates it */
  }
}

/** Parse marker JSON, returning null for anything that isn't the expected shape. */
export function parseCleanShutdownMarker(jsonText: string | null | undefined): CleanShutdownMarker | null {
  if (typeof jsonText !== "string" || !jsonText.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { version, closedAt, dbSize, dbMtimeMs } = data as Record<string, unknown>;
  if (typeof version !== "number") return null;
  if (typeof closedAt !== "string") return null;
  if (typeof dbSize !== "number" || !Number.isFinite(dbSize)) return null;
  if (typeof dbMtimeMs !== "number" || !Number.isFinite(dbMtimeMs)) return null;
  return { version, closedAt, dbSize, dbMtimeMs };
}

/**
 * Decide whether the last shutdown can be trusted as clean. Pure-ish: reads the
 * marker and stats the DB/WAL, but has no side effects and never throws.
 */
export function readCleanShutdownState(dbPath: string): CleanShutdownState {
  let st: { size: number; mtimeMs: number };
  try {
    if (!existsSync(dbPath)) return { trusted: false, reason: "db-missing" };
    st = statSync(dbPath);
  } catch {
    return { trusted: false, reason: "db-missing" };
  }

  // The WAL check is independent of the marker on purpose — see header.
  if (!walIsDrained(dbPath)) return { trusted: false, reason: "wal-not-empty" };

  const markerPath = markerPathFor(dbPath);
  if (!existsSync(markerPath)) return { trusted: false, reason: "no-marker" };

  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch {
    return { trusted: false, reason: "unreadable-marker" };
  }

  const marker = parseCleanShutdownMarker(raw);
  if (!marker) return { trusted: false, reason: "unreadable-marker" };
  if (marker.version !== MARKER_VERSION) return { trusted: false, reason: "version-mismatch" };
  if (marker.dbSize !== st.size || marker.dbMtimeMs !== st.mtimeMs) {
    return { trusted: false, reason: "db-changed" };
  }
  return { trusted: true, reason: "trusted" };
}

/**
 * The gate itself, kept pure so the policy is testable without a filesystem.
 *
 * Runs the check when ANY of these hold:
 *   - forced via `MINDER_FORCE_QUICK_CHECK=1`;
 *   - the last shutdown wasn't provably clean;
 *   - the DB is small enough that the scan is effectively free.
 */
export function shouldRunQuickCheck(opts: {
  cleanShutdown: boolean;
  dbSizeBytes: number;
  force?: boolean;
  /** Override for the always-check threshold; defaults to the env-aware value. */
  alwaysCheckBelowBytes?: number;
}): boolean {
  if (opts.force) return true;
  if (!opts.cleanShutdown) return true;
  const threshold = opts.alwaysCheckBelowBytes ?? quickCheckAlwaysMaxBytes();
  return opts.dbSizeBytes < threshold;
}

/** `MINDER_FORCE_QUICK_CHECK=1` — support escape hatch for a full scan. */
export function quickCheckForced(): boolean {
  return process.env.MINDER_FORCE_QUICK_CHECK === "1";
}
