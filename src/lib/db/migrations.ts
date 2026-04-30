import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { existsSync, readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";
import { DB_DIR, DB_PATH, getDb, closeDb } from "./connection";

// Migration runner for the local SQLite index.
//
// The DB is purely a derived index — it can be rebuilt from the filesystem
// at any time. So our "migration story" is two-track:
//
// 1. **Additive forward migrations.** Adding columns, tables, indexes is
//    cheap. We run pending migrations (those whose version > the recorded
//    `schema_version`) in order at startup. Each is wrapped in a
//    transaction so a half-applied migration is impossible.
//
// 2. **Corruption recovery via rebuild.** If `PRAGMA integrity_check`
//    returns anything other than 'ok' on startup, we close the connection,
//    rename the file aside (`index.db.corrupt-<ts>`), and the indexer
//    rebuilds from scratch on its next sweep. No "repair the DB"
//    machinery — the source of truth is the filesystem.

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseT.Database) => void;
}

/**
 * Migration registry. Append new entries with monotonically increasing
 * versions; never modify or delete an entry once shipped (the DB on
 * someone's machine has already run it).
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: (db) => {
      const schemaPath = resolveSchemaPath();
      const sql = readFileSync(schemaPath, "utf-8");
      // better-sqlite3's multi-statement runner. Not child_process — this
      // is the same name happening to be in the SQLite driver's API.
      db.exec(sql);
    },
  },
];

function resolveSchemaPath(): string {
  // The compiled output of this module lives next to schema.sql, so
  // __dirname/schema.sql is the canonical lookup. Fallback walks up
  // looking for src/lib/db/schema.sql so tests run from any cwd find it.
  const sibling = path.join(__dirname, "schema.sql");
  if (existsSync(sibling)) return sibling;
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "src", "lib", "db", "schema.sql");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("schema.sql not found; expected at src/lib/db/schema.sql");
}

function getCurrentVersion(db: DatabaseT.Database): number {
  // The first migration creates the meta table, so on a fresh DB the
  // table won't exist yet — that's the signal to start at 0.
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get() as { name?: string } | undefined;
  if (!row) return 0;
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  return versionRow ? parseInt(versionRow.value!, 10) || 0 : 0;
}

function setCurrentVersion(db: DatabaseT.Database, version: number): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version));
}

/**
 * Run any migrations whose version is greater than the recorded
 * `schema_version`. Each migration runs inside its own transaction so a
 * thrown migration leaves the previous version intact.
 */
function applyPendingMigrations(db: DatabaseT.Database): { applied: number[]; current: number } {
  const current = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );
  const applied: number[] = [];
  for (const migration of pending) {
    const txn = db.transaction(() => {
      migration.up(db);
      setCurrentVersion(db, migration.version);
    });
    txn();
    applied.push(migration.version);
  }
  return { applied, current: getCurrentVersion(db) };
}

/**
 * Rename a corrupt DB file aside. The next `getDb()` will open a fresh
 * empty DB at the same path; the indexer rebuilds the contents.
 *
 * Windows-specific retry loop: closing a SQLite DB handle releases the
 * underlying file lock asynchronously on Windows. A `rename` call that
 * lands within ~tens of milliseconds of `close()` can fail with EBUSY.
 * We retry a few times with a short backoff before giving up.
 */
async function quarantineCorruptDb(reason: string): Promise<string | null> {
  try {
    await fs.access(DB_PATH);
  } catch {
    return null; // nothing to quarantine
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(DB_DIR, `index.db.corrupt-${stamp}`);

  let renamed = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rename(DB_PATH, dest);
      renamed = true;
      break;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }

  if (!renamed) {
    // Last resort on Windows: rename keeps failing because something still
    // holds a file lock. Forensic preservation is nice-to-have; clearing
    // the slot so the rebuild can proceed is the must-have. fs.rm with
    // maxRetries was added for exactly this OS-level lock-release lag.
    try {
      await fs.rm(DB_PATH, { force: true, maxRetries: 10, retryDelay: 100 });
      // eslint-disable-next-line no-console
      console.warn(
        `[db] Could not preserve corrupt index (rename kept failing): ${(lastErr as Error)?.message ?? "unknown"}. ` +
          `Deleted instead so rebuild can proceed.`
      );
      // Clean WAL/SHM siblings if present.
      for (const ext of [".wal", ".shm"]) {
        try {
          await fs.rm(DB_PATH + ext, { force: true, maxRetries: 5, retryDelay: 50 });
        } catch { /* may not exist */ }
      }
      return null;
    } catch (rmErr) {
      // If even rm failed, something is genuinely wrong — bubble the
      // original rename error since it was the first symptom.
      throw lastErr ?? rmErr;
    }
  }

  // Also move the WAL/SHM siblings if they exist — leftover WAL on a fresh
  // DB at the same path causes "database disk image is malformed".
  for (const ext of [".wal", ".shm"]) {
    try {
      await fs.rename(DB_PATH + ext, dest + ext);
    } catch {
      /* may not exist */
    }
  }
  // eslint-disable-next-line no-console
  console.warn(`[db] Quarantined corrupt index to ${dest} (${reason}). Will rebuild.`);
  return dest;
}

export interface InitResult {
  available: boolean;
  appliedMigrations: number[];
  schemaVersion: number;
  quarantined: string | null;
  error: Error | null;
}

/**
 * Open the DB, run integrity check, apply pending migrations. Idempotent —
 * call from indexer startup and from any read-side path that wants the
 * DB ready before its first query.
 *
 * Three corruption recovery paths are wired in:
 *   1. `getDb()` returns null (open threw) — try once to quarantine the
 *      file at DB_PATH and reopen.
 *   2. `PRAGMA integrity_check` returns non-'ok' — quarantine and reopen.
 *   3. Migration throws — bubbled up as `result.error`.
 *
 * The indexer is responsible for repopulating the rebuilt DB.
 */
export async function initDb(): Promise<InitResult> {
  const result: InitResult = {
    available: false,
    appliedMigrations: [],
    schemaVersion: 0,
    quarantined: null,
    error: null,
  };

  let db = await getDb();
  if (!db) {
    // Path 1: open threw. Most common cause is a corrupt file from a
    // previous unclean shutdown. Try to quarantine and reopen once.
    result.quarantined = await quarantineCorruptDb("open failed; possible corruption");
    db = await getDb();
    if (!db) {
      result.error = new Error("better-sqlite3 unavailable or DB failed to open after quarantine");
      return result;
    }
  }

  // Path 2: integrity_check on every open. Fast on a healthy DB.
  const integrity = db.prepare("PRAGMA integrity_check").get() as {
    integrity_check?: string;
  };
  if (integrity.integrity_check !== "ok") {
    closeDb();
    result.quarantined = await quarantineCorruptDb(
      `integrity_check returned ${integrity.integrity_check}`
    );
    db = await getDb();
    if (!db) {
      result.error = new Error("Failed to reopen DB after quarantine");
      return result;
    }
  }

  try {
    const { applied, current } = applyPendingMigrations(db);
    result.available = true;
    result.appliedMigrations = applied;
    result.schemaVersion = current;
    return result;
  } catch (err) {
    result.error = err as Error;
    return result;
  }
}
