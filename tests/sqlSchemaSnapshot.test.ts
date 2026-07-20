import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { SQL_SCHEMA } from "@/lib/sqlSchemaSnapshot";
// Import the path rather than recomputing `os.homedir()/.minder/index.db`:
// recomputing it pinned this check to the REAL home no matter how the suite was
// isolated, so on CI it opened whichever half-built database another test had
// leaked there and read an empty `meta` (#330). Importing means it now sees the
// isolated per-file state dir, where no DB exists — so the live check skips, as
// it always intended to when there is nothing to check.
import { DB_PATH } from "@/lib/db/connection";

let driverAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  /* driver not installed — skip live checks */
}

describe("SQL_SCHEMA", () => {
  it("has at least one table", () => {
    expect(SQL_SCHEMA.length).toBeGreaterThan(0);
  });

  it("each entry has a non-empty table name and at least one column", () => {
    for (const entry of SQL_SCHEMA) {
      expect(entry.table, "table name must be a non-empty string").toBeTruthy();
      expect(entry.columns.length, `${entry.table} must have at least one column`).toBeGreaterThan(0);
      for (const col of entry.columns) {
        expect(col, `column in ${entry.table}`).toBeTruthy();
      }
    }
  });

  it("has no duplicate table names", () => {
    const names = SQL_SCHEMA.map((e) => e.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes both regular and virtual (FTS5) tables", () => {
    const regular = SQL_SCHEMA.filter((e) => !e.virtual);
    const virtual = SQL_SCHEMA.filter((e) => e.virtual);
    expect(regular.length).toBeGreaterThan(0);
    expect(virtual.length).toBeGreaterThan(0);
  });

  it("includes the sessions table", () => {
    const sessions = SQL_SCHEMA.find((e) => e.table === "sessions");
    expect(sessions).toBeDefined();
    expect(sessions!.columns).toContain("session_id");
    expect(sessions!.columns).toContain("project_slug");
  });
});

/**
 * Is there a DB here that has finished migrating?
 *
 * `existsSync(DB_PATH)` alone was not a sufficient guard (#330). On CI the file
 * can exist while another test file is still building it, so this block would
 * open a half-migrated database and read an empty `PRAGMA table_info` — failing
 * on `meta` with `expected [] to deeply equal ["key", "value"]`. It passed on a
 * re-run with no code change, and only ever on Windows, where slower scheduling
 * widens the window between file creation and migration completion.
 *
 * The question this check needs answered is not "does a file exist" but "is
 * there a migrated schema to compare against". Anything else is not a failure —
 * it is nothing to test, which is what the skip already meant to express.
 */
function migratedDbPresent(): boolean {
  if (!driverAvailable || !existsSync(DB_PATH)) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const cols = db.prepare(`PRAGMA table_info("meta")`).all() as unknown[];
      return cols.length > 0;
    } finally {
      db.close();
    }
  } catch {
    // Locked, corrupt, or mid-write — not a schema to check.
    return false;
  }
}

describe.skipIf(!migratedDbPresent())("live DB column check", () => {
  it("snapshot columns match PRAGMA table_info for each non-virtual table", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(DB_PATH, { readonly: true });
    try {
      for (const entry of SQL_SCHEMA.filter((e) => !e.virtual)) {
        const pragmaRows = db
          .prepare(`PRAGMA table_info("${entry.table}")`)
          .all() as { name: string }[];
        const liveColumns = pragmaRows.map((r: { name: string }) => r.name);
        expect(liveColumns, `table "${entry.table}" live columns`).toEqual(
          expect.arrayContaining(entry.columns)
        );
        expect(entry.columns, `table "${entry.table}" snapshot columns`).toEqual(
          expect.arrayContaining(liveColumns)
        );
      }
    } finally {
      db.close();
    }
  });
});
