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

function buildMemDb(): DatabaseT.Database {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  const stmts = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    db.prepare(stmt).run();
  }
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
    expect(task.execution_mode).toBe("stream");
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
});
