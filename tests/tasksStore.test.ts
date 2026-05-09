import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

// Store tests wire an in-memory SQLite DB into the module graph.
// vi.mock calls are hoisted to the top of the file by vitest, so the
// mock factories use a module-level `memDb` ref that's populated in
// beforeAll — before any store function is called.
// server-only is stubbed globally via vitest.config.ts alias.

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available */
}

// Module-level ref populated in beforeAll before any store calls.
let memDb: DatabaseT.Database | null = null;

// These are hoisted by vitest to the top of the module before any imports.
vi.mock("@/lib/tasksDb/migrations", () => ({
  initTasksDb: vi.fn().mockResolvedValue({ available: true }),
}));
vi.mock("@/lib/tasksDb/connection", () => ({
  getTasksDb: vi.fn(async () => memDb),
  prepTasksCached: (_db: DatabaseT.Database, sql: string) => _db.prepare(sql),
}));

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "tasksDb", "schema.sql");

function runSql(db: DatabaseT.Database, sql: string) {
  const stmts = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    db.prepare(stmt).run();
  }
}

function buildMemDb(): DatabaseT.Database {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  runSql(db, readFileSync(SCHEMA_PATH, "utf-8"));
  // Apply v2 migration: rebuild ops_tasks with delegated-todo quadrant + metadata column
  runSql(db, `
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
    CREATE INDEX IF NOT EXISTS ix_task_decisions_task ON task_decisions(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_decisions_open ON task_decisions(decided_at) WHERE decided_at IS NULL;
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      blocker_id  INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (task_id != blocker_id),
      UNIQUE (task_id, blocker_id)
    );
    CREATE INDEX IF NOT EXISTS ix_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_deps_blocker ON task_dependencies(blocker_id)
  `);
  // v5: ops_swarms + swarm columns
  runSql(db, `
    CREATE TABLE IF NOT EXISTS ops_swarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('worktree','shared')),
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
             CHECK (status IN ('running','done','failed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT
    );
    ALTER TABLE ops_tasks ADD COLUMN swarm_id INTEGER REFERENCES ops_swarms(id) ON DELETE SET NULL;
    ALTER TABLE ops_tasks ADD COLUMN swarm_role TEXT CHECK (swarm_role IN ('member','coordinator') OR swarm_role IS NULL);
    CREATE INDEX IF NOT EXISTS ix_tasks_swarm ON ops_tasks(swarm_id) WHERE swarm_id IS NOT NULL
  `);
  return db;
}

describe.skipIf(!Database)("tasksStore CRUD", () => {
  let store: typeof import("@/lib/tasks/store");

  beforeAll(async () => {
    memDb = buildMemDb();
    // Import AFTER memDb is set so the first ensureReady() call finds a DB.
    store = await import("@/lib/tasks/store");
  });

  afterAll(() => {
    memDb?.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Task CRUD
  // -------------------------------------------------------------------------

  it("createTask inserts a row with defaults and returns it", async () => {
    const task = await store.createTask({ title: "My first task" });
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe("My first task");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe(3);
    expect(task.quadrant).toBe("do");
    expect(task.execution_mode).toBe("classic");
    expect(task.risk_level).toBe("low");
  });

  it("getTask returns the inserted row by id", async () => {
    const created = await store.createTask({ title: "Fetch me" });
    const fetched = await store.getTask(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Fetch me");
  });

  it("getTask returns null for unknown id", async () => {
    expect(await store.getTask(99999)).toBeNull();
  });

  it("listTasks returns all tasks", async () => {
    const before = await store.listTasks();
    await store.createTask({ title: "Alpha" });
    await store.createTask({ title: "Beta" });
    const after = await store.listTasks();
    expect(after.length).toBe(before.length + 2);
  });

  it("listTasks filters by status", async () => {
    await store.createTask({ title: "Pending task" });
    const results = await store.listTasks({ status: "pending" });
    expect(results.every((t) => t.status === "pending")).toBe(true);
  });

  it("patchTask updates title", async () => {
    const task = await store.createTask({ title: "Old title" });
    const updated = await store.patchTask(task.id, { title: "New title" });
    expect(updated!.title).toBe("New title");
  });

  it("patchTask updates status", async () => {
    const task = await store.createTask({ title: "Status test" });
    const updated = await store.patchTask(task.id, { status: "cancelled" });
    expect(updated!.status).toBe("cancelled");
  });

  it("patchTask returns null for unknown id", async () => {
    expect(await store.patchTask(99999, { title: "ghost" })).toBeNull();
  });

  it("deleteTask removes the row and returns true", async () => {
    const task = await store.createTask({ title: "Delete me" });
    const deleted = await store.deleteTask(task.id);
    expect(deleted).toBe(true);
    expect(await store.getTask(task.id)).toBeNull();
  });

  it("deleteTask returns false for unknown id", async () => {
    expect(await store.deleteTask(99999)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // claimPendingTask — atomic dispatcher claim
  // -------------------------------------------------------------------------

  it("claimPendingTask transitions a pending task to running", async () => {
    await store.createTask({ title: "Claimable" });
    const claimed = await store.claimPendingTask();
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");
    expect(claimed!.started_at).toBeTruthy();
  });

  it("claimPendingTask returns null when no pending tasks remain", async () => {
    const pending = await store.listTasks({ status: "pending" });
    for (const t of pending) {
      await store.patchTask(t.id, { status: "cancelled" });
    }
    expect(await store.claimPendingTask()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Schedule CRUD
  // -------------------------------------------------------------------------

  it("createSchedule inserts a row and computes next_run_at", async () => {
    const sched = await store.createSchedule({
      name: "Daily 9am",
      cron_expression: "0 9 * * *",
      task_title: "Morning sync",
    });
    expect(sched.id).toBeGreaterThan(0);
    expect(sched.name).toBe("Daily 9am");
    expect(sched.enabled).toBe(1);
    expect(sched.next_run_at).toBeTruthy();
  });

  it("getSchedule returns the inserted row", async () => {
    const created = await store.createSchedule({
      name: "Weekly",
      cron_expression: "0 10 * * 1",
      task_title: "Weekly review",
    });
    const fetched = await store.getSchedule(created.id);
    expect(fetched!.name).toBe("Weekly");
  });

  it("getSchedule returns null for unknown id", async () => {
    expect(await store.getSchedule(99999)).toBeNull();
  });

  it("listSchedules returns all schedules", async () => {
    const before = await store.listSchedules();
    await store.createSchedule({ name: "Extra", cron_expression: "* * * * *", task_title: "t" });
    const after = await store.listSchedules();
    expect(after.length).toBe(before.length + 1);
  });

  it("patchSchedule updates name and recomputes next_run_at on cron change", async () => {
    const sched = await store.createSchedule({
      name: "Old name",
      cron_expression: "0 9 * * *",
      task_title: "t",
    });
    const updated = await store.patchSchedule(sched.id, {
      name: "New name",
      cron_expression: "0 18 * * *",
    });
    expect(updated!.name).toBe("New name");
    expect(updated!.cron_expression).toBe("0 18 * * *");
    expect(updated!.next_run_at).toBeTruthy();
  });

  it("deleteSchedule removes the row and returns true", async () => {
    const sched = await store.createSchedule({
      name: "To delete",
      cron_expression: "* * * * *",
      task_title: "t",
    });
    expect(await store.deleteSchedule(sched.id)).toBe(true);
    expect(await store.getSchedule(sched.id)).toBeNull();
  });

  it("deleteSchedule returns false for unknown id", async () => {
    expect(await store.deleteSchedule(99999)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Dispatcher lifecycle helpers
  // -------------------------------------------------------------------------

  it("approveTask transitions awaiting_approval → pending and sets approved_at", async () => {
    const t = await store.createTask({ title: "Needs approval", requires_approval: true });
    // Manually set to awaiting_approval (simulating dispatcher promotion)
    await store.patchTask(t.id, { status: "awaiting_approval" });

    const approved = await store.approveTask(t.id);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("pending");
    expect(approved!.approved_at).toBeTruthy();
  });

  it("approveTask returns null when task is not awaiting_approval", async () => {
    const t = await store.createTask({ title: "Still pending" });
    const result = await store.approveTask(t.id);
    expect(result).toBeNull(); // pending ≠ awaiting_approval
  });

  it("rerunTask transitions failed → pending and clears output fields", async () => {
    const t = await store.createTask({ title: "Will fail" });
    // Simulate running then failing
    await store.patchTask(t.id, { status: "running" });
    await store.failTask(t.id, { error_message: "Some error", duration_ms: 500 });

    const rerun = await store.rerunTask(t.id);
    expect(rerun).not.toBeNull();
    expect(rerun!.status).toBe("pending");
    expect(rerun!.error_message).toBeNull();
    expect(rerun!.started_at).toBeNull();
    expect(rerun!.completed_at).toBeNull();
    expect(rerun!.duration_ms).toBeNull();
  });

  it("rerunTask returns null when task is not failed", async () => {
    const t = await store.createTask({ title: "Pending task" });
    expect(await store.rerunTask(t.id)).toBeNull();
  });

  it("completeTask marks running task as done with output", async () => {
    const t = await store.createTask({ title: "Will complete" });
    await store.patchTask(t.id, { status: "running" });

    const done = await store.completeTask(t.id, {
      output_summary: "All tasks done",
      duration_ms: 1234,
      cost_usd: 0.0005,
    });
    expect(done).not.toBeNull();
    expect(done!.status).toBe("done");
    expect(done!.output_summary).toBe("All tasks done");
    expect(done!.duration_ms).toBe(1234);
    expect(done!.cost_usd).toBe(0.0005);
    expect(done!.consecutive_failures).toBe(0);
    expect(done!.completed_at).toBeTruthy();
  });

  it("failTask marks running task as failed and increments consecutive_failures", async () => {
    const t = await store.createTask({ title: "Will fail" });
    await store.patchTask(t.id, { status: "running" });

    const failed = await store.failTask(t.id, { error_message: "oops", duration_ms: 100 });
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.error_message).toBe("oops");
    expect(failed!.consecutive_failures).toBe(1);

    // Rerun and fail again to verify increment
    await store.rerunTask(t.id);
    await store.patchTask(t.id, { status: "running" });
    const failed2 = await store.failTask(t.id, { error_message: "oops again" });
    expect(failed2!.consecutive_failures).toBe(2);
  });

  it("promoteApprovalTasks transitions pending+requires_approval tasks to awaiting_approval", async () => {
    const t = await store.createTask({ title: "Needs HITL", requires_approval: true });
    expect(t.status).toBe("pending");

    const count = await store.promoteApprovalTasks();
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await store.getTask(t.id);
    expect(updated!.status).toBe("awaiting_approval");
  });

  it("materializeSchedules creates a task row for each due schedule", async () => {
    const sched = await store.createSchedule({
      name: "Instant run",
      cron_expression: "* * * * *",
      task_title: "Materialized task",
    });
    // Force next_run_at to the past so it's immediately due
    memDb!.prepare("UPDATE ops_schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      sched.id
    );

    const before = await store.listTasks();
    const created = await store.materializeSchedules();
    expect(created).toBeGreaterThanOrEqual(1);

    const after = await store.listTasks();
    expect(after.length).toBe(before.length + created);

    const newTask = after.find((t) => t.schedule_id === sched.id);
    expect(newTask).toBeDefined();
    expect(newTask!.title).toBe("Materialized task");
  });
});
