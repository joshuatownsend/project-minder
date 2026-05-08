import "server-only";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";
import {
  TASKS_DB_DIR,
  TASKS_DB_PATH,
  getTasksDb,
  getTasksDbError,
  closeTasksDb,
  isTasksDriverLoaded,
} from "./connection";
import { renameWithRetry } from "../atomicWrite";

// Migration runner for ~/.minder/tasks.db.
// Mirrors src/lib/db/migrations.ts structure — independent registry, fresh
// version numbering starting at 1 (no relationship to sessions DB versions).

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseT.Database) => void;
}

/**
 * Run a multi-statement SQL string against the DB. Strips line comments,
 * splits on semicolons, and prepares+runs each statement individually.
 * Used by v1 to apply the schema file without needing the SQLite
 * multi-statement runner (which is named the same as the shell utility
 * and trips security linters).
 */
function runStatements(db: DatabaseT.Database, sql: string): void {
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.prepare(stmt).run();
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial ops_tasks + ops_schedules schema",
    up: (db) => {
      const schemaPath = resolveTasksSchemaPath();
      const sql = readFileSync(schemaPath, "utf-8");
      runStatements(db, sql);
    },
  },
];

function resolveTasksSchemaPath(): string {
  const sibling = path.join(__dirname, "schema.sql");
  if (existsSync(sibling)) return sibling;
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "src", "lib", "tasksDb", "schema.sql");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("tasks schema.sql not found; expected at src/lib/tasksDb/schema.sql");
}

class SchemaVersionMissingError extends Error {
  readonly schemaVersionMissing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionMissingError";
  }
}

function getCurrentVersion(db: DatabaseT.Database): number {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get() as { name?: string } | undefined;
  if (!row) return 0;
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (!versionRow) {
    throw new SchemaVersionMissingError("meta table present but schema_version row missing");
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

function applyPendingMigrations(
  db: DatabaseT.Database
): { applied: number[]; current: number } {
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

async function moveOrDeleteTasksDbSiblings(dest: string | null): Promise<void> {
  for (const ext of [".wal", ".shm"]) {
    const src = TASKS_DB_PATH + ext;
    if (dest) {
      try {
        await renameWithRetry(src, dest + ext);
        continue;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
      }
    }
    try {
      await fs.rm(src, { force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
}

async function quarantineCorruptTasksDb(reason: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(TASKS_DB_DIR, `tasks.db.corrupt-${stamp}`);
  try {
    await renameWithRetry(TASKS_DB_PATH, dest);
    await moveOrDeleteTasksDbSiblings(dest);
    console.warn(`[tasksDb] Quarantined corrupt tasks DB to ${dest} (${reason}). Will rebuild.`);
    return dest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    try {
      await fs.rm(TASKS_DB_PATH, { force: true, maxRetries: 10, retryDelay: 100 });
      await moveOrDeleteTasksDbSiblings(null);
      console.warn("[tasksDb] Could not preserve corrupt tasks DB; deleted instead so rebuild can proceed.");
      return null;
    } catch {
      throw err;
    }
  }
}

export interface TasksInitResult {
  available: boolean;
  appliedMigrations: number[];
  schemaVersion: number;
  quarantined: string | null;
  error: Error | null;
}

/**
 * Open tasks.db, run integrity check, apply pending migrations. Idempotent.
 * Recovery mirrors initDb() in src/lib/db/migrations.ts.
 */
export async function initTasksDb(): Promise<TasksInitResult> {
  const result: TasksInitResult = {
    available: false,
    appliedMigrations: [],
    schemaVersion: 0,
    quarantined: null,
    error: null,
  };

  if (!isTasksDriverLoaded()) {
    const cause = getTasksDbError();
    result.error = new Error("better-sqlite3 driver unavailable on this platform", {
      cause: cause ?? undefined,
    });
    return result;
  }

  let db = await getTasksDb();
  if (!db) {
    result.quarantined = await quarantineCorruptTasksDb("open failed; possible corruption");
    db = await getTasksDb();
    if (!db) {
      result.error = new Error("Tasks DB failed to open after quarantine", {
        cause: getTasksDbError() ?? undefined,
      });
      return result;
    }
  }

  const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
  if (integrity.quick_check !== "ok") {
    closeTasksDb();
    result.quarantined = await quarantineCorruptTasksDb(
      `quick_check returned ${integrity.quick_check}`
    );
    db = await getTasksDb();
    if (!db) {
      result.error = new Error("Failed to reopen tasks DB after quarantine", {
        cause: getTasksDbError() ?? undefined,
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
    if (err instanceof SchemaVersionMissingError) {
      closeTasksDb();
      result.quarantined = await quarantineCorruptTasksDb(
        `schema_version unreadable: ${(err as Error).message}`
      );
      const reopened = await getTasksDb();
      if (!reopened) {
        result.error = new Error("Failed to reopen tasks DB after schema_version quarantine", {
          cause: getTasksDbError() ?? undefined,
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
