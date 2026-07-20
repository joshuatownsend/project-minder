import "server-only";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";

// Local SQLite DB for Mission Control task queue. Sits at ~/.minder/tasks.db.
//
// Forked from src/lib/db/connection.ts — same patterns, separate singleton
// and separate DB file. We fork (rather than parameterize) because
// connection.ts owns one prepared-statement cache and one globalThis key;
// adding a second would force changes through every read façade in lib/data/.
//
// Design mirrors lib/db/connection.ts:
// * Optional better-sqlite3 dependency — loads at module init, available flag.
// * globalThis singleton via __minderTasksDb survives Next.js HMR reloads.
// * WAL + mmap_size=256MB + busy_timeout=5000ms.
// * Prepared-statement cache keyed by SQL text; foreign handles (tests) bypass it.

let Database: typeof DatabaseT | null = null;
let loadError: Error | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch (err) {
  loadError = err as Error;
}

/** Same resolution as the index DB — see the note on `DB_DIR` in
 *  `src/lib/db/connection.ts` for why this honours `MINDER_STATE_DIR` but
 *  falls back to `~/.minder` rather than to `resolveStateDir()`. */
export const TASKS_DB_DIR = process.env.MINDER_STATE_DIR || path.join(os.homedir(), ".minder");
export const TASKS_DB_PATH = path.join(TASKS_DB_DIR, "tasks.db");

interface ConnectionState {
  db: DatabaseT.Database | null;
  lastError: Error | null;
  inFlight: Promise<DatabaseT.Database | null> | null;
  preparedCache: Map<string, DatabaseT.Statement> | null;
  /**
   * Latched by `checkpointAndCloseTasksDb()` during graceful shutdown (A2).
   * Once set, `getTasksDb()` refuses to re-open — a late write (e.g. a spawned
   * task's `completeTask` firing after its child exits post-shutdown) must NOT
   * silently resurrect the DB handle we just closed and checkpointed. Those
   * rows are instead reclaimed by the next boot's stale-PID sweep / reconcile,
   * the same contract as a crash. Process-lifetime sticky (we're exiting).
   */
  shutdownClosed: boolean;
}

const g = globalThis as unknown as {
  __minderTasksDb?: ConnectionState;
};

if (!g.__minderTasksDb) {
  g.__minderTasksDb = {
    db: null,
    lastError: loadError,
    inFlight: null,
    preparedCache: null,
    shutdownClosed: false,
  };
}

const state = g.__minderTasksDb;

async function ensureTasksDbDir(): Promise<void> {
  await fs.mkdir(TASKS_DB_DIR, { recursive: true });
}

export async function getTasksDb(): Promise<DatabaseT.Database | null> {
  if (!Database) return null;
  // Closed for shutdown — never re-open (see `shutdownClosed`). Returning null
  // makes every store write funnelling through `ensureReady()` fail safely (or
  // no-op where guarded) instead of resurrecting the handle mid-process-exit.
  if (state.shutdownClosed) return null;
  if (state.db) return state.db;
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      await ensureTasksDbDir();
      if (state.db) return state.db;
      // F11: shutdown may have latched the connection closed WHILE we awaited
      // ensureTasksDbDir() — the initial guard above ran before the flag flipped.
      // Re-check here so a mid-flight open can't hand back a fresh handle the
      // close disposer already believed it had prevented.
      if (state.shutdownClosed) return null;
      const db = new Database!(TASKS_DB_PATH);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("foreign_keys = ON");
      db.pragma("mmap_size = 268435456"); // 256 MB
      db.pragma("temp_store = MEMORY");
      db.pragma("busy_timeout = 5000");
      state.db = db;
      state.preparedCache = new Map();
      state.lastError = null;
      return db;
    } catch (err) {
      state.lastError = err as Error;
      return null;
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

export function isTasksDriverLoaded(): boolean {
  return Database !== null;
}

export function getTasksDbSync(): DatabaseT.Database | null {
  return state.db;
}

export function isTasksDbAvailable(): boolean {
  return Database !== null && state.db !== null;
}

export function getTasksDbError(): Error | null {
  return state.lastError;
}

export function closeTasksDb(): void {
  if (state.db) {
    try { state.db.close(); } catch { /* ignore */ }
    state.db = null;
    state.preparedCache = null;
  }
}

/**
 * Graceful-shutdown close (A2), mirroring `checkpointAndCloseDb()` in
 * `db/connection.ts`: checkpoint the WAL into the main `tasks.db` file, then
 * close the handle, so a supervised stop doesn't leave a `-wal`/`-shm` pair for
 * the next boot to recover. Respects the better-sqlite3-absent / DB-not-open
 * path — no open connection means nothing to flush, a clean no-op. Never
 * throws (a failed checkpoint must not block the rest of shutdown). Registered
 * as the `tasksDb` shutdown disposer, ordered to run after the dispatcher (its
 * only writer) has stopped.
 */
export async function checkpointAndCloseTasksDb(): Promise<void> {
  // Latch FIRST (synchronous), before any await could interleave a getTasksDb()
  // race: from here on no code path may re-open the DB, even the no-open path
  // below where there's nothing to flush.
  state.shutdownClosed = true;
  // F11: an open already in flight when we latch would, after its own await,
  // otherwise construct a fresh handle. It now re-checks `shutdownClosed` and
  // bails to null — but await it here anyway so that, whichever side won the
  // race, we then close whatever handle actually landed in `state.db`.
  if (state.inFlight) {
    try {
      await state.inFlight;
    } catch {
      /* the open failed — nothing to close */
    }
  }
  const db = state.db;
  if (!db) return; // driver missing, or no connection open — nothing to flush
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* best-effort — fall through to close regardless */
  }
  closeTasksDb();
}

/** True once `checkpointAndCloseTasksDb()` has latched the connection closed for
 *  shutdown. Read by store completion-path writers to no-op cleanly. */
export function isTasksDbShutdownClosed(): boolean {
  return state.shutdownClosed;
}

/** @internal Test-only: clear the shutdown latch (and close any handle) so a
 *  test that exercised `checkpointAndCloseTasksDb()` doesn't leak the sticky
 *  flag into later cases in the same file. */
export function _resetTasksDbShutdownForTesting(): void {
  closeTasksDb();
  state.shutdownClosed = false;
}

export function prepTasksCached(
  db: DatabaseT.Database,
  sql: string
): DatabaseT.Statement {
  if (db !== state.db || !state.preparedCache) {
    return db.prepare(sql);
  }
  let stmt = state.preparedCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    state.preparedCache.set(sql, stmt);
  }
  return stmt;
}

/** @internal Test-only: current cache size. */
export function tasksDbPreparedCacheSize(): number {
  return state.preparedCache?.size ?? 0;
}
