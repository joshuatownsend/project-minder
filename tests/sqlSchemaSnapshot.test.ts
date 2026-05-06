import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { SQL_SCHEMA } from "@/lib/sqlSchemaSnapshot";

const DB_PATH = path.join(os.homedir(), ".minder", "index.db");

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

describe.skipIf(!driverAvailable || !existsSync(DB_PATH))("live DB column check", () => {
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
