import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

// Store-level tests for task_dependencies: addDependency, removeDependency,
// listDependencies, listAllDependencies, and claimPendingTask blocker guard.
// Mirror pattern from tasksStore.test.ts.

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available */
}

let memDb: DatabaseT.Database | null = null;

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
  for (const stmt of stmts) db.prepare(stmt).run();
}

function buildMemDb(): DatabaseT.Database {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  runSql(db, readFileSync(SCHEMA_PATH, "utf-8"));
  // v2 migration: delegated-todo + metadata + task_decisions
  runSql(db, `
    CREATE TABLE ops_tasks_v2 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','awaiting_approval','running','done','failed','cancelled')),
      priority            INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
      quadrant            TEXT NOT NULL DEFAULT 'do'
        CHECK (quadrant IN ('do','schedule','delegate','archive','delegated-todo')),
      assigned_skill      TEXT, model TEXT,
      execution_mode      TEXT NOT NULL DEFAULT 'stream'
        CHECK (execution_mode IN ('classic','stream')),
      scheduled_for       TEXT,
      requires_approval   INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
      risk_level          TEXT NOT NULL DEFAULT 'low'
        CHECK (risk_level IN ('low','medium','high')),
      dry_run             INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
      schedule_id         INTEGER REFERENCES ops_schedules(id) ON DELETE SET NULL,
      approved_at TEXT, session_id TEXT, started_at TEXT, completed_at TEXT,
      duration_ms INTEGER, cost_usd REAL, output_summary TEXT, error_message TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      metadata TEXT
    );
    INSERT INTO ops_tasks_v2
      SELECT id,title,description,status,priority,quadrant,assigned_skill,model,
             execution_mode,scheduled_for,requires_approval,risk_level,dry_run,
             schedule_id,approved_at,session_id,started_at,completed_at,
             duration_ms,cost_usd,output_summary,error_message,consecutive_failures,created_at,NULL
      FROM ops_tasks;
    DROP TABLE ops_tasks;
    ALTER TABLE ops_tasks_v2 RENAME TO ops_tasks;
    CREATE INDEX IF NOT EXISTS ix_tasks_status ON ops_tasks(status);
    CREATE INDEX IF NOT EXISTS ix_tasks_quadrant ON ops_tasks(quadrant);
    CREATE INDEX IF NOT EXISTS ix_tasks_scheduled ON ops_tasks(scheduled_for) WHERE scheduled_for IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tasks_schedule_fk ON ops_tasks(schedule_id) WHERE schedule_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tasks_session ON ops_tasks(session_id) WHERE session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      session_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('decision','inbox')),
      prompt TEXT NOT NULL, choices TEXT, decision_text TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), decided_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_task_decisions_dedup
      ON task_decisions(task_id, kind, prompt) WHERE kind = 'decision' AND decided_at IS NULL;
    CREATE INDEX IF NOT EXISTS ix_task_decisions_task ON task_decisions(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_decisions_open ON task_decisions(decided_at) WHERE decided_at IS NULL;
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      blocker_id INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (task_id != blocker_id),
      UNIQUE (task_id, blocker_id)
    );
    CREATE INDEX IF NOT EXISTS ix_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_deps_blocker ON task_dependencies(blocker_id);
  `);
  return db;
}

describe.skipIf(!Database)("task_dependencies store", () => {
  let store: typeof import("@/lib/tasks/store");

  beforeAll(async () => {
    memDb = buildMemDb();
    store = await import("@/lib/tasks/store");
  });

  afterAll(() => {
    memDb?.close();
    vi.restoreAllMocks();
  });

  async function createTask(title: string) {
    return store.createTask({ title });
  }

  it("addDependency inserts edge and returns row", async () => {
    const a = await createTask("A");
    const b = await createTask("B");
    const dep = await store.addDependency(b.id, a.id);
    expect(dep.task_id).toBe(b.id);
    expect(dep.blocker_id).toBe(a.id);
    expect(typeof dep.id).toBe("number");
  });

  it("addDependency is idempotent on duplicate", async () => {
    const a = await createTask("A2");
    const b = await createTask("B2");
    const dep1 = await store.addDependency(b.id, a.id);
    const dep2 = await store.addDependency(b.id, a.id);
    expect(dep1.id).toBe(dep2.id);
  });

  it("addDependency rejects self-loop", async () => {
    const a = await createTask("Self");
    await expect(store.addDependency(a.id, a.id)).rejects.toThrow();
  });

  it("addDependency rejects direct cycle (A→B then B→A)", async () => {
    const a = await createTask("Cycle-A");
    const b = await createTask("Cycle-B");
    await store.addDependency(b.id, a.id); // b is blocked by a
    // now try a is blocked by b — would close a cycle
    const { CycleError } = await import("@/lib/tasks/store");
    await expect(store.addDependency(a.id, b.id)).rejects.toThrow(CycleError);
  });

  it("addDependency rejects transitive cycle (A→B→C→A)", async () => {
    const a = await createTask("TC-A");
    const b = await createTask("TC-B");
    const c = await createTask("TC-C");
    await store.addDependency(b.id, a.id); // b blocked by a
    await store.addDependency(c.id, b.id); // c blocked by b
    const { CycleError } = await import("@/lib/tasks/store");
    await expect(store.addDependency(a.id, c.id)).rejects.toThrow(CycleError);
  });

  it("removeDependency returns true when edge existed", async () => {
    const a = await createTask("Rm-A");
    const b = await createTask("Rm-B");
    await store.addDependency(b.id, a.id);
    const removed = await store.removeDependency(b.id, a.id);
    expect(removed).toBe(true);
  });

  it("removeDependency returns false when edge did not exist", async () => {
    const a = await createTask("Rm-None-A");
    const b = await createTask("Rm-None-B");
    const removed = await store.removeDependency(b.id, a.id);
    expect(removed).toBe(false);
  });

  it("listDependencies returns blockedBy and blocks arrays", async () => {
    const a = await createTask("List-A");
    const b = await createTask("List-B");
    const c = await createTask("List-C");
    await store.addDependency(b.id, a.id); // b blocked by a
    await store.addDependency(c.id, a.id); // c blocked by a

    const fromA = await store.listDependencies(a.id);
    expect(fromA.blockedBy).toHaveLength(0);
    expect(fromA.blocks).toContain(b.id);
    expect(fromA.blocks).toContain(c.id);

    const fromB = await store.listDependencies(b.id);
    expect(fromB.blockedBy).toContain(a.id);
    expect(fromB.blocks).toHaveLength(0);
  });

  it("listAllDependencies returns all rows", async () => {
    const before = (await store.listAllDependencies()).length;
    const a = await createTask("All-A");
    const b = await createTask("All-B");
    await store.addDependency(b.id, a.id);
    const after = await store.listAllDependencies();
    expect(after.length).toBe(before + 1);
  });

  it("claimPendingTask skips tasks whose blocker is not done", async () => {
    const blocker = await createTask("Blocker");
    const blocked = await createTask("Blocked");
    await store.addDependency(blocked.id, blocker.id);

    // Only 'blocked' is pending — blocker is also pending, so blocked can't be claimed.
    // Mark blocker as running so it's out of the pending pool too.
    await store.patchTask(blocker.id, { status: "running" });

    const claimed = await store.claimPendingTask();
    // 'blocked' should NOT be claimed while blocker is running (not done).
    const claimedId = claimed?.id;
    expect(claimedId).not.toBe(blocked.id);
  });

  it("claimPendingTask allows task once all blockers are done", async () => {
    const blocker = await createTask("Done-Blocker");
    const blocked = await createTask("Unblocked-Dependent");
    await store.addDependency(blocked.id, blocker.id);

    await store.patchTask(blocker.id, { status: "done" });
    // Cancel all other pending tasks so only 'blocked' is claimable.
    memDb!
      .prepare("UPDATE ops_tasks SET status = 'cancelled' WHERE status = 'pending' AND id != ?")
      .run(blocked.id);

    const claimed = await store.claimPendingTask();
    expect(claimed?.id).toBe(blocked.id);
  });

  it("createTask with blockedBy inserts edges atomically", async () => {
    const a = await createTask("Atomic-Blocker");
    const b = await store.createTask({ title: "Atomic-Dependent", blockedBy: [a.id] });
    const deps = await store.listDependencies(b.id);
    expect(deps.blockedBy).toContain(a.id);
  });
});
