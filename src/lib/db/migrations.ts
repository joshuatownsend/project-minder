import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { existsSync, readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";
import { DB_DIR, DB_PATH, getDb, getDbError, closeDb, isDriverLoaded } from "./connection";
import { renameWithRetry } from "../atomicWrite";

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
  {
    version: 2,
    name: "add turns.tool_result_preview",
    up: (db) => {
      // Idempotent: fresh DBs ran the latest schema.sql in v1 which already
      // includes the column. Only existing DBs upgraded from v1 need the
      // ALTER. SQLite doesn't have ADD COLUMN IF NOT EXISTS so we check
      // the current schema before adding.
      const cols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "tool_result_preview")) {
        db.exec("ALTER TABLE turns ADD COLUMN tool_result_preview TEXT");
      }
    },
  },
  {
    version: 3,
    name: "add cost_usd / one-shot counts / category_costs rollup",
    up: (db) => {
      // Schema additions that unlock the SQL-aggregate read path on
      // /api/usage (P2b-2.5). All ALTERs are idempotent — fresh DBs got
      // the columns via v1's schema.sql; only DBs upgraded from v1/v2
      // need the structural change.
      //
      // Cost backfill is NOT done here — pricing data lives in JS and is
      // loaded asynchronously, which won't fit a sync migration. Instead
      // we set `meta.needs_reconcile_after_v3 = 1` so the read-side
      // façade falls back to file-parse until the next reconcile (which
      // is forced by the bumped `DERIVED_VERSION` constant) populates
      // `turns.cost_usd` and the rollup. The reconcile clears the flag
      // on success.
      const turnCols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!turnCols.some((c) => c.name === "cost_usd")) {
        db.exec("ALTER TABLE turns ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
      }
      const sessionCols = db
        .prepare("PRAGMA table_info(sessions)")
        .all() as Array<{ name: string }>;
      if (!sessionCols.some((c) => c.name === "verified_task_count")) {
        db.exec("ALTER TABLE sessions ADD COLUMN verified_task_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!sessionCols.some((c) => c.name === "one_shot_task_count")) {
        db.exec("ALTER TABLE sessions ADD COLUMN one_shot_task_count INTEGER NOT NULL DEFAULT 0");
      }
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='category_costs'")
        .get() as { name?: string } | undefined;
      if (!tableExists) {
        db.exec(`
          CREATE TABLE category_costs (
            day           TEXT NOT NULL,
            project_slug  TEXT NOT NULL,
            category      TEXT NOT NULL,
            turns         INTEGER NOT NULL DEFAULT 0,
            tokens        INTEGER NOT NULL DEFAULT 0,
            cost_usd      REAL    NOT NULL DEFAULT 0,
            PRIMARY KEY (day, project_slug, category)
          ) WITHOUT ROWID;
          CREATE INDEX category_costs_by_day ON category_costs(day DESC);
        `);
      }
      // Readiness gate: the SQL-aggregate path is unsafe to use until the
      // bumped DERIVED_VERSION drives a full re-parse. Cleared by
      // `reconcileAllSessions` on success. Survives process restarts so
      // a crash mid-rebuild doesn't leave the read path serving zeros.
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('needs_reconcile_after_v3', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run();
    },
  },
  {
    version: 4,
    name: "drop turns_ad cascade trigger",
    up: (db) => {
      // The AFTER DELETE trigger on `turns` filtered on the UNINDEXED
      // `session_id` / `turn_index` columns of `prompts_fts`, forcing a
      // full table scan per cascade-deleted turn. With ~120k turns and
      // hundreds of cascade deletes per session-replace, that scan
      // dominated reconcile wall-time. `turns` is `WITHOUT ROWID`, so
      // the FTS5 rowid-alignment trick doesn't apply — instead the
      // writer bulk-deletes `prompts_fts` rows for the session in one
      // scan before the cascade.
      db.exec("DROP TRIGGER IF EXISTS turns_ad");
    },
  },
  {
    version: 5,
    name: "sessions: slug + continued_from_session_id",
    up: (db) => {
      // Idempotent ALTER pattern (same as v3): fresh DBs already have the
      // columns from v1's schema.sql; only DBs upgraded from v1–v4 need
      // the structural change.
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "slug")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN slug TEXT").run();
      }
      if (!cols.some((c) => c.name === "continued_from_session_id")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN continued_from_session_id TEXT").run();
      }
      db.prepare(
        "CREATE INDEX IF NOT EXISTS sessions_by_slug ON sessions(slug) WHERE slug IS NOT NULL"
      ).run();
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

/**
 * Sentinel error used to signal "the meta table tells us this DB has
 * already been initialized but its schema_version stamp is missing or
 * unreadable." Distinguishable by initDb() so it can route to the
 * quarantine-and-rebuild path rather than blindly re-running v1 (which
 * would fail with "table already exists").
 */
class SchemaVersionMissingError extends Error {
  readonly schemaVersionMissing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionMissingError";
  }
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
  if (!versionRow) {
    // meta exists but the stamp is gone. Re-running v1 would fail with
    // "table already exists" because v1's schema.sql is plain CREATE
    // TABLE statements. Treat as corruption — caller quarantines.
    throw new SchemaVersionMissingError(
      "meta table present but schema_version row missing"
    );
  }
  const parsed = parseInt(versionRow.value!, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SchemaVersionMissingError(
      `meta.schema_version is unreadable: ${JSON.stringify(versionRow.value)}`
    );
  }
  return parsed;
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
 * Move WAL/SHM siblings of `DB_PATH` to `dest` siblings (rename) or
 * delete them outright. Leftover WAL on a fresh DB at the same path
 * causes "database disk image is malformed" on next open, so a sibling
 * that won't move and won't delete is genuinely dangerous.
 *
 * The rename path uses `renameWithRetry` because WAL/SHM hold the same
 * Windows file-lock-release-lag as the main DB. If retries exhaust, we
 * fall back to delete — losing forensic snapshots of the WAL beats
 * leaving a poison pill in place.
 */
async function moveOrDeleteSiblings(dest: string | null): Promise<void> {
  for (const ext of [".wal", ".shm"]) {
    const src = DB_PATH + ext;
    if (dest) {
      try {
        await renameWithRetry(src, dest + ext);
        continue;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // didn't exist, fine
        // Rename gave up — fall through to delete so the rebuilt DB
        // doesn't reopen against a stale WAL.
      }
    }
    try {
      await fs.rm(src, { force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* may not exist or genuinely stuck — best effort */
    }
  }
}

/**
 * Rename a corrupt DB file aside. The next `getDb()` will open a fresh
 * empty DB at the same path; the indexer rebuilds the contents.
 *
 * On Windows, file handles release asynchronously after close — see
 * `renameWithRetry` for the retry rationale. If rename still fails after
 * the retry budget we fall back to deleting the file: forensic
 * preservation is nice-to-have, clearing the slot for rebuild is the
 * must-have.
 */
async function quarantineCorruptDb(reason: string): Promise<string | null> {
  // No `fs.access` pre-check — rename's ENOENT path tells us "nothing to
  // quarantine" without a TOCTOU window.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(DB_DIR, `index.db.corrupt-${stamp}`);

  try {
    await renameWithRetry(DB_PATH, dest);
    await moveOrDeleteSiblings(dest);
    // eslint-disable-next-line no-console
    console.warn(`[db] Quarantined corrupt index to ${dest} (${reason}). Will rebuild.`);
    return dest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // nothing to quarantine
    // Rename gave up after retries (still locked, or some other failure).
    // Fall back to outright delete so the rebuild can proceed.
    try {
      await fs.rm(DB_PATH, { force: true, maxRetries: 10, retryDelay: 100 });
      await moveOrDeleteSiblings(null);
      // eslint-disable-next-line no-console
      console.warn(
        `[db] Could not preserve corrupt index (rename kept failing): ${(err as Error).message}. ` +
          `Deleted instead so rebuild can proceed.`
      );
      return null;
    } catch {
      throw err; // bubble the original symptom
    }
  }
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
 * Recovery paths:
 *   0. Driver missing (`isDriverLoaded() === false`) — return cleanly
 *      with `available: false` and no quarantine. The caller (read-side
 *      façade) falls back to file-parse mode. We never quarantine here
 *      because the file isn't necessarily corrupt — the platform just
 *      lacks the binary.
 *   1. `getDb()` returns null with driver loaded — assume corruption,
 *      quarantine and reopen once.
 *   2. `PRAGMA quick_check` returns non-'ok' — quarantine and reopen.
 *   3. `getCurrentVersion` throws SchemaVersionMissingError — meta table
 *      exists but stamp is gone; re-running v1 would fail with "table
 *      already exists." Quarantine and reopen.
 *   4. Migration throws (non-corruption) — bubbled up as `result.error`.
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

  // Path 0: driver missing. Don't quarantine — the file is fine, the
  // platform just lacks the native binary. Surface the underlying load
  // error so debug surfaces can distinguish "no binary" from "broken DB".
  if (!isDriverLoaded()) {
    const cause = getDbError();
    result.error = new Error("better-sqlite3 driver unavailable on this platform", {
      cause: cause ?? undefined,
    });
    return result;
  }

  let db = await getDb();
  if (!db) {
    // Path 1: driver loaded but open threw. Most common cause is a
    // corrupt file from a previous unclean shutdown. Try to quarantine
    // and reopen once.
    result.quarantined = await quarantineCorruptDb("open failed; possible corruption");
    db = await getDb();
    if (!db) {
      result.error = new Error("DB failed to open after quarantine", {
        cause: getDbError() ?? undefined,
      });
      return result;
    }
  }

  // Path 2: quick_check on every open. quick_check is materially cheaper
  // than integrity_check (skips index/UNIQUE cross-checks) and catches the
  // same corruption classes that matter for a derived index — page-level
  // damage and freelist breakage. We can rebuild from the JSONLs anyway,
  // so we don't need integrity_check's index-level assurance on startup.
  const integrity = db.prepare("PRAGMA quick_check").get() as {
    quick_check?: string;
  };
  if (integrity.quick_check !== "ok") {
    closeDb();
    result.quarantined = await quarantineCorruptDb(
      `quick_check returned ${integrity.quick_check}`
    );
    db = await getDb();
    if (!db) {
      result.error = new Error("Failed to reopen DB after quarantine", {
        cause: getDbError() ?? undefined,
      });
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
    // Path 3: SchemaVersionMissingError — meta table exists but stamp is
    // missing. Quarantine and retry once. Any other error bubbles.
    if (err instanceof SchemaVersionMissingError) {
      closeDb();
      result.quarantined = await quarantineCorruptDb(`schema_version unreadable: ${err.message}`);
      const reopened = await getDb();
      if (!reopened) {
        result.error = new Error("Failed to reopen DB after schema_version quarantine", {
          cause: getDbError() ?? undefined,
        });
        return result;
      }
      try {
        const { applied, current } = applyPendingMigrations(reopened);
        result.available = true;
        result.appliedMigrations = applied;
        result.schemaVersion = current;
        return result;
      } catch (retryErr) {
        result.error = retryErr as Error;
        return result;
      }
    }
    result.error = err as Error;
    return result;
  }
}
