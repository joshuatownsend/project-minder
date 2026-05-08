import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

// Validates schema v1 constraints and index existence without touching
// ~/.minder/tasks.db. Uses the same :memory: pattern as dbSchema.test.ts.
// Statements are run individually via prepare/run so that partial failures
// surface the offending statement — same strategy as migrations.ts.

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available — describe.skipIf handles below */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "tasksDb", "schema.sql");

function runSql(db: DatabaseT.Database, sql: string): void {
  const stmts = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    db.prepare(stmt).run();
  }
}

function openWithSchema(): DatabaseT.Database {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  runSql(db, readFileSync(SCHEMA_PATH, "utf-8"));
  return db;
}

describe.skipIf(!Database)("tasks schema v1", () => {
  let db: DatabaseT.Database;

  beforeAll(() => {
    db = openWithSchema();
  });

  afterAll(() => {
    db.close();
  });

  it("creates meta, ops_schedules, and ops_tasks tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("meta");
    expect(tables).toContain("ops_schedules");
    expect(tables).toContain("ops_tasks");
  });

  it("creates all 5 indexes on ops_tasks", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("ix_tasks_status");
    expect(indexes).toContain("ix_tasks_quadrant");
    expect(indexes).toContain("ix_tasks_scheduled");
    expect(indexes).toContain("ix_tasks_schedule_fk");
    expect(indexes).toContain("ix_tasks_session");
  });

  it("creates index on ops_schedules", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("ix_schedules_active");
  });

  it("inserts a task row with defaults", () => {
    const row: any = db
      .prepare("INSERT INTO ops_tasks (title) VALUES (?) RETURNING *")
      .get("test task");
    expect(row.title).toBe("test task");
    expect(row.status).toBe("pending");
    expect(row.priority).toBe(3);
    expect(row.quadrant).toBe("do");
    expect(row.execution_mode).toBe("stream");
    expect(row.risk_level).toBe("low");
    expect(row.requires_approval).toBe(0);
    expect(row.dry_run).toBe(0);
    expect(row.consecutive_failures).toBe(0);
    expect(row.created_at).toBeTruthy();
  });

  it("rejects invalid status value via CHECK constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, status) VALUES (?, ?)").run("x", "invalid_status");
    }).toThrow();
  });

  it("rejects priority out of range via CHECK constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, priority) VALUES (?, ?)").run("x", 0);
    }).toThrow();
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, priority) VALUES (?, ?)").run("x", 6);
    }).toThrow();
  });

  it("rejects invalid quadrant via CHECK constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, quadrant) VALUES (?, ?)").run("x", "backlog");
    }).toThrow();
  });

  it("rejects invalid execution_mode via CHECK constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, execution_mode) VALUES (?, ?)").run("x", "turbo");
    }).toThrow();
  });

  it("rejects invalid risk_level via CHECK constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO ops_tasks (title, risk_level) VALUES (?, ?)").run("x", "extreme");
    }).toThrow();
  });

  it("schedule_id FK causes SET NULL on schedule delete", () => {
    const sched: any = db
      .prepare("INSERT INTO ops_schedules (name, cron_expression, task_title) VALUES (?, ?, ?) RETURNING *")
      .get("s1", "* * * * *", "title");
    db
      .prepare("INSERT INTO ops_tasks (title, schedule_id) VALUES (?, ?)")
      .run("linked task", sched.id);
    db.prepare("DELETE FROM ops_schedules WHERE id = ?").run(sched.id);
    const task: any = db
      .prepare("SELECT schedule_id FROM ops_tasks WHERE title = ?")
      .get("linked task");
    expect(task.schedule_id).toBeNull();
  });

  it("meta table accepts key/value pairs", () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "1");
    const row: any = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
    expect(row.value).toBe("1");
  });

  it("second schema run is idempotent (IF NOT EXISTS)", () => {
    expect(() => {
      runSql(db, readFileSync(SCHEMA_PATH, "utf-8"));
    }).not.toThrow();
  });
});
