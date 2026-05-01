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
  /** Last init error, if any. Useful for debug surfaces. */
  lastError: Error | null;
  /**
   * In-flight open promise. Single-flight guard: if two callers race into
   * `getDb()` while the DB isn't yet open, both await the same promise
   * instead of each calling `new Database(...)` and leaking a handle.
   */
  inFlight: Promise<DatabaseT.Database | null> | null;
  /**
   * Prepared-statement cache, keyed by literal SQL text. Lifecycle is 1:1
   * with the `db` handle: created in `getDb()` on a successful open,
   * nulled in `closeDb()` together with `db`. Foreign db handles (e.g.,
   * a fresh `Database` opened in a test) bypass the cache via the
   * identity check in `prepCached`.
   */
  preparedCache: Map<string, DatabaseT.Statement> | null;
}

const g = globalThis as unknown as {
  __minderDb?: ConnectionState;
};

if (!g.__minderDb) {
  g.__minderDb = {
    db: null,
    lastError: loadError,
    inFlight: null,
    preparedCache: null,
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
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      await ensureDbDir();
      // Re-check after the await: another caller may have raced through
      // ensureDbDir on an earlier turn of the event loop. Without this
      // we'd open two handles when the singleton was meant to gate.
      if (state.db) return state.db;
      const db = new Database!(DB_PATH);
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

/**
 * `true` when the better-sqlite3 native binary loaded successfully at
 * module init. Distinct from `isDbAvailable()`: this is "can we ever
 * open a DB on this platform?" while `isDbAvailable()` is "is one open
 * right now?". Used by `initDb()` to distinguish driver-missing (no
 * recovery possible, return cleanly) from open-failed (try quarantine).
 */
export function isDriverLoaded(): boolean {
  return Database !== null;
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
 * `true` when better-sqlite3 loaded AND a connection is currently open.
 * Derived from state, not a sticky flag — flips back to false after
 * `closeDb()`. Read this before assuming the index is queryable.
 */
export function isDbAvailable(): boolean {
  return Database !== null && state.db !== null;
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
    state.preparedCache = null;
  }
  // Don't null inFlight: if a concurrent open is mid-flight it will clear
  // itself in the finally block. Pre-emptively nulling it would let a
  // second concurrent caller spawn a duplicate open.
}

/**
 * Cached `db.prepare(sql)`. Memoizes the resulting `Statement` per
 * literal SQL string against the singleton db handle so a hot read
 * path doesn't re-parse the same query on every request.
 *
 * Caching applies only when `db` is the singleton owned by this module
 * (`state.db`). Foreign db handles — e.g., a `Database` opened
 * directly in a test — fall through to a plain `db.prepare(sql)` so
 * test isolation is preserved.
 *
 * **Do not pass dynamic SQL** (string-interpolated WHERE clauses,
 * user-supplied SQL): the cache is unbounded by design, so unique
 * inputs would leak memory. Templated callers must bind parameters
 * with `@name` and keep the SQL string itself static.
 */
export function prepCached(
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

/** @internal Test-only: current cache size, or 0 when no db is open. */
export function preparedCacheSize(): number {
  return state.preparedCache?.size ?? 0;
}
