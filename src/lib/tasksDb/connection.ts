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

export const TASKS_DB_DIR = path.join(os.homedir(), ".minder");
export const TASKS_DB_PATH = path.join(TASKS_DB_DIR, "tasks.db");

interface ConnectionState {
  db: DatabaseT.Database | null;
  lastError: Error | null;
  inFlight: Promise<DatabaseT.Database | null> | null;
  preparedCache: Map<string, DatabaseT.Statement> | null;
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
  };
}

const state = g.__minderTasksDb;

async function ensureTasksDbDir(): Promise<void> {
  await fs.mkdir(TASKS_DB_DIR, { recursive: true });
}

export async function getTasksDb(): Promise<DatabaseT.Database | null> {
  if (!Database) return null;
  if (state.db) return state.db;
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      await ensureTasksDbDir();
      if (state.db) return state.db;
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
