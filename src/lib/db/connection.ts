import "server-only";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";

// Local SQLite index for Project Minder. Sits at ~/.minder/index.db.
//
// Design:
//
// * **Optional dependency.** `better-sqlite3` ships prebuilt binaries for
//   common platforms but uncommon ones can fail to load. We catch that at
//   module init and expose `available: false` so the read-side façade can
//   fall through to the file-parse path. The server never crashes on a
//   missing native binary.
//
// * **`globalThis` singleton.** Survives Next.js HMR module reloads — the
//   same pattern used everywhere else in this codebase. Without it every
//   dev save would close and reopen the DB, which churns WAL files and
//   breaks any in-flight write.
//
// * **WAL mode + concurrent readers.** WAL lets a single writer (the
//   indexer worker) coexist with many concurrent readers (the route
//   handlers in P2b). `synchronous=NORMAL` is the right durability/speed
//   trade-off for a derived index — power-loss recovery just rebuilds.
//
// * **`mmap_size=256MB`** keeps hot pages in mapped memory; with our
//   expected DB size of ~50–150 MB this means most reads are page faults,
//   not syscalls.
//
// * **`server-only` import** ensures this module never accidentally bundles
//   into a client component.

let Database: typeof DatabaseT | null = null;
let loadError: Error | null = null;
try {
  // Dynamic require so the import can fail without breaking the module graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch (err) {
  loadError = err as Error;
}

export const DB_DIR = path.join(os.homedir(), ".minder");
export const DB_PATH = path.join(DB_DIR, "index.db");

interface ConnectionState {
  db: DatabaseT.Database | null;
  available: boolean;
  /** Last init error, if any. Useful for debug surfaces. */
  lastError: Error | null;
}

const g = globalThis as unknown as {
  __minderDb?: ConnectionState;
};

if (!g.__minderDb) {
  g.__minderDb = {
    db: null,
    // `available` flips to true only after the first successful open.
    // Until then, it tracks "did the native binary load at all?" — flipping
    // to false only when require() failed, never on a transient open
    // failure (corrupt file, permission, etc.) that initDb can recover from.
    available: false,
    lastError: loadError,
  };
}

const state = g.__minderDb;

/**
 * Ensure `~/.minder/` exists. Called before opening the DB.
 */
async function ensureDbDir(): Promise<void> {
  await fs.mkdir(DB_DIR, { recursive: true });
}

/**
 * Open (or return the cached) database connection. Returns `null` if
 * better-sqlite3 didn't load. A failure to open (corrupt file, locked,
 * etc.) is recorded on `lastError` but does NOT permanently flip
 * `available` to false — callers like initDb may want to quarantine and
 * retry. For the "platform really doesn't have native binary" case,
 * `Database === null` is the durable signal.
 */
export async function getDb(): Promise<DatabaseT.Database | null> {
  if (!Database) return null;
  if (state.db) return state.db;

  try {
    await ensureDbDir();
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("mmap_size = 268435456"); // 256 MB
    db.pragma("temp_store = MEMORY");
    db.pragma("busy_timeout = 5000");
    state.db = db;
    state.available = true;
    return db;
  } catch (err) {
    state.lastError = err as Error;
    return null;
  }
}

/**
 * Synchronous variant for code that already holds a live connection (e.g.
 * the indexer worker after `getDb()` has succeeded once). Returns null if
 * the DB isn't open yet — never opens it itself.
 */
export function getDbSync(): DatabaseT.Database | null {
  return state.db;
}

/**
 * `true` when better-sqlite3 loaded and (after `getDb()` ran) the DB
 * opened successfully. Read this before assuming the index is queryable.
 */
export function isDbAvailable(): boolean {
  return state.available;
}

export function getDbError(): Error | null {
  return state.lastError;
}

/**
 * Close the connection. Used during HMR cleanup so the next module load
 * gets a fresh handle. Idempotent.
 */
export function closeDb(): void {
  if (state.db) {
    try { state.db.close(); } catch { /* ignore */ }
    state.db = null;
  }
}
