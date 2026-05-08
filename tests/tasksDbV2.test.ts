import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

// Tests the v2 migration: task_decisions table, partial UNIQUE index, and
// delegated-todo quadrant enforcement. Runs against an in-memory DB so it
// does not touch ~/.minder/tasks.db.

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not installed — tests will be skipped */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "tasksDb", "schema.sql");

// Mirror of migrations.ts runStatements — strips line comments, splits on ';', runs each
function runStatements(db: DatabaseT.Database, sql: string): void {
  const stmts = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    db.prepare(stmt).run();
  }
}

function openV1() {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  runStatements(db, sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  return db;
}

function applyV2(db: DatabaseT.Database) {
  runStatements(db, `
    CREATE TABLE ops_tasks_v2 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT    NOT NULL,
      description         TEXT    NOT NULL DEFAULT '',
      status              TEXT    NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','awaiting_approval','running','done','failed','cancelled')),
      priority            INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
      quadrant            TEXT    NOT NULL DEFAULT 'do'
        CHECK (quadrant IN ('do','schedule','delegate','archive','delegated-todo')),
      assigned_skill      TEXT,
      model               TEXT,
      execution_mode      TEXT    NOT NULL DEFAULT 'stream'
        CHECK (execution_mode IN ('classic','stream')),
      scheduled_for       TEXT,
      requires_approval   INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
      risk_level          TEXT    NOT NULL DEFAULT 'low'
        CHECK (risk_level IN ('low','medium','high')),
      dry_run             INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
      schedule_id         INTEGER REFERENCES ops_schedules(id) ON DELETE SET NULL,
      approved_at         TEXT,
      session_id          TEXT,
      started_at          TEXT,
      completed_at        TEXT,
      duration_ms         INTEGER,
      cost_usd            REAL,
      output_summary      TEXT,
      error_message       TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      metadata            TEXT
    );
    INSERT INTO ops_tasks_v2
      SELECT id,title,description,status,priority,quadrant,assigned_skill,model,
             execution_mode,scheduled_for,requires_approval,risk_level,dry_run,
             schedule_id,approved_at,session_id,started_at,completed_at,
             duration_ms,cost_usd,output_summary,error_message,
             consecutive_failures,created_at,NULL
      FROM ops_tasks;
    DROP TABLE ops_tasks;
    ALTER TABLE ops_tasks_v2 RENAME TO ops_tasks;
    CREATE INDEX IF NOT EXISTS ix_tasks_status ON ops_tasks(status);
    CREATE INDEX IF NOT EXISTS ix_tasks_quadrant ON ops_tasks(quadrant);
    CREATE INDEX IF NOT EXISTS ix_tasks_scheduled ON ops_tasks(scheduled_for) WHERE scheduled_for IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tasks_schedule_fk ON ops_tasks(schedule_id) WHERE schedule_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tasks_session ON ops_tasks(session_id) WHERE session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      session_id  TEXT,
      kind        TEXT NOT NULL CHECK (kind IN ('decision','inbox')),
      prompt      TEXT NOT NULL,
      choices     TEXT,
      decision_text TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      decided_at  INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_task_decisions_dedup
      ON task_decisions(session_id, prompt)
      WHERE decided_at IS NULL;
    CREATE INDEX IF NOT EXISTS ix_task_decisions_task
      ON task_decisions(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_decisions_open
      ON task_decisions(decided_at) WHERE decided_at IS NULL;
  `);
}

describe.skipIf(!Database)("tasksDb v2 migration", () => {
  let db: DatabaseT.Database;

  beforeAll(() => {
    db = openV1();
    applyV2(db);
  });

  it("creates the task_decisions table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("task_decisions");
  });

  it("adds the metadata column to ops_tasks", () => {
    const cols = db
      .prepare("PRAGMA table_info(ops_tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("metadata");
  });

  it("allows inserting delegated-todo quadrant", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO ops_tasks (title, quadrant) VALUES ('Delegate me', 'delegated-todo')"
      ).run();
    }).not.toThrow();
  });

  it("still rejects invalid quadrant values", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO ops_tasks (title, quadrant) VALUES ('Bad', 'invalid-quadrant')"
      ).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("partial UNIQUE index blocks duplicate open decisions per (session_id, prompt)", () => {
    const task = db.prepare("INSERT INTO ops_tasks (title) VALUES ('HITL task')").run();
    const taskId = task.lastInsertRowid as number;

    db.prepare(
      "INSERT INTO task_decisions (task_id, session_id, kind, prompt) VALUES (?, 's1', 'decision', 'Overwrite?')"
    ).run(taskId);

    expect(() => {
      db.prepare(
        "INSERT INTO task_decisions (task_id, session_id, kind, prompt) VALUES (?, 's1', 'decision', 'Overwrite?')"
      ).run(taskId);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it("allows same (session_id, prompt) once decided_at is set", () => {
    const task = db.prepare("INSERT INTO ops_tasks (title) VALUES ('HITL task 2')").run();
    const taskId = task.lastInsertRowid as number;

    const d = db.prepare(
      "INSERT INTO task_decisions (task_id, session_id, kind, prompt) VALUES (?, 's2', 'decision', 'Continue?')"
    ).run(taskId);
    db.prepare("UPDATE task_decisions SET decided_at = unixepoch() WHERE id = ?").run(
      d.lastInsertRowid
    );

    expect(() => {
      db.prepare(
        "INSERT INTO task_decisions (task_id, session_id, kind, prompt) VALUES (?, 's2', 'decision', 'Continue?')"
      ).run(taskId);
    }).not.toThrow();
  });

  it("deletes task_decisions rows when parent ops_tasks row is deleted (CASCADE)", () => {
    const task = db.prepare("INSERT INTO ops_tasks (title) VALUES ('To delete')").run();
    const taskId = task.lastInsertRowid as number;
    db.prepare(
      "INSERT INTO task_decisions (task_id, session_id, kind, prompt) VALUES (?, 's3', 'inbox', 'Working...')"
    ).run(taskId);

    db.prepare("DELETE FROM ops_tasks WHERE id = ?").run(taskId);

    const rows = db.prepare("SELECT id FROM task_decisions WHERE task_id = ?").all(taskId);
    expect(rows).toHaveLength(0);
  });
});
