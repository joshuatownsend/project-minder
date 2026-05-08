import "server-only";
import type DatabaseT from "better-sqlite3";
import { initTasksDb } from "../tasksDb/migrations";
import { getTasksDb, prepTasksCached } from "../tasksDb/connection";
import { computeNextRun } from "./cron";
import type {
  Task,
  Schedule,
  CreateTaskInput,
  PatchTaskInput,
  CreateScheduleInput,
  PatchScheduleInput,
  TaskListFilter,
} from "./types";

// Lazily initialized once and then cached in globalThis via initTasksDb().
// All exported functions call ensureReady() first, then use the DB.

let initPromise: Promise<void> | null = null;

async function ensureReady(): Promise<DatabaseT.Database> {
  if (!initPromise) {
    initPromise = initTasksDb().then((r) => {
      if (!r.available) {
        initPromise = null; // allow retry on next call
        throw new Error(
          r.error?.message ?? "Tasks DB unavailable (better-sqlite3 driver missing or DB corrupt)"
        );
      }
    });
  }
  await initPromise;
  const db = await getTasksDb();
  if (!db) throw new Error("Tasks DB not open after successful init");
  return db;
}

// ---------------------------------------------------------------------------
// Tasks CRUD
// ---------------------------------------------------------------------------

export async function listTasks(filter?: TaskListFilter): Promise<Task[]> {
  const db = await ensureReady();
  let sql = "SELECT * FROM ops_tasks";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.quadrant) {
    conditions.push("quadrant = ?");
    params.push(filter.quadrant);
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY created_at DESC";

  return db.prepare(sql).all(...params) as Task[];
}

export async function getTask(id: number): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(db, "SELECT * FROM ops_tasks WHERE id = ?").get(id) as Task | undefined;
  return row ?? null;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const db = await ensureReady();
  const result = prepTasksCached(
    db,
    `INSERT INTO ops_tasks
      (title, description, priority, quadrant, assigned_skill, model,
       execution_mode, scheduled_for, requires_approval, risk_level, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).get(
    input.title,
    input.description ?? "",
    input.priority ?? 3,
    input.quadrant ?? "do",
    input.assigned_skill ?? null,
    input.model ?? null,
    input.execution_mode ?? "stream",
    input.scheduled_for ?? null,
    input.requires_approval ? 1 : 0,
    input.risk_level ?? "low",
    input.dry_run ? 1 : 0
  ) as Task;
  return result;
}

export async function patchTask(id: number, input: PatchTaskInput): Promise<Task | null> {
  const db = await ensureReady();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (input.title !== undefined) { setClauses.push("title = ?"); params.push(input.title.trim()); }
  if (input.description !== undefined) { setClauses.push("description = ?"); params.push(input.description); }
  if (input.priority !== undefined) { setClauses.push("priority = ?"); params.push(input.priority); }
  if (input.quadrant !== undefined) { setClauses.push("quadrant = ?"); params.push(input.quadrant); }
  if ("assigned_skill" in input) { setClauses.push("assigned_skill = ?"); params.push(input.assigned_skill ?? null); }
  if ("model" in input) { setClauses.push("model = ?"); params.push(input.model ?? null); }
  if (input.execution_mode !== undefined) { setClauses.push("execution_mode = ?"); params.push(input.execution_mode); }
  if ("scheduled_for" in input) { setClauses.push("scheduled_for = ?"); params.push(input.scheduled_for ?? null); }
  if (input.requires_approval !== undefined) { setClauses.push("requires_approval = ?"); params.push(input.requires_approval ? 1 : 0); }
  if (input.risk_level !== undefined) { setClauses.push("risk_level = ?"); params.push(input.risk_level); }
  if (input.dry_run !== undefined) { setClauses.push("dry_run = ?"); params.push(input.dry_run ? 1 : 0); }
  if (input.status !== undefined) { setClauses.push("status = ?"); params.push(input.status); }

  if (setClauses.length === 0) {
    return getTask(id);
  }

  params.push(id);
  const sql = `UPDATE ops_tasks SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`;
  const row = db.prepare(sql).get(...params) as Task | undefined;
  return row ?? null;
}

export async function deleteTask(id: number): Promise<boolean> {
  const db = await ensureReady();
  const result = prepTasksCached(db, "DELETE FROM ops_tasks WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Atomically claim the next pending task for the dispatcher.
 * Uses UPDATE...WHERE status='pending' to prevent race conditions.
 * Returns the claimed task or null if no pending tasks exist.
 * Used by Wave 9.1b dispatcher — exported here so the schema round-trips
 * can be tested independently of the dispatcher singleton.
 */
export async function claimPendingTask(): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = (
       SELECT id FROM ops_tasks
       WHERE status = 'pending'
         AND (scheduled_for IS NULL OR scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ).get() as Task | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Schedules CRUD
// ---------------------------------------------------------------------------

export async function listSchedules(): Promise<Schedule[]> {
  const db = await ensureReady();
  return prepTasksCached(
    db,
    "SELECT * FROM ops_schedules ORDER BY created_at DESC"
  ).all() as Schedule[];
}

export async function getSchedule(id: number): Promise<Schedule | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    "SELECT * FROM ops_schedules WHERE id = ?"
  ).get(id) as Schedule | undefined;
  return row ?? null;
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const db = await ensureReady();
  const nextRun = computeNextRun(input.cron_expression);
  const result = prepTasksCached(
    db,
    `INSERT INTO ops_schedules
      (name, cron_expression, task_title, task_description, assigned_skill, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).get(
    input.name,
    input.cron_expression,
    input.task_title,
    input.task_description ?? "",
    input.assigned_skill ?? null,
    input.enabled === false ? 0 : 1,
    nextRun ? nextRun.toISOString() : null
  ) as Schedule;
  return result;
}

export async function patchSchedule(
  id: number,
  input: PatchScheduleInput
): Promise<Schedule | null> {
  const db = await ensureReady();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) { setClauses.push("name = ?"); params.push(input.name.trim()); }
  if (input.task_title !== undefined) { setClauses.push("task_title = ?"); params.push(input.task_title.trim()); }
  if (input.task_description !== undefined) { setClauses.push("task_description = ?"); params.push(input.task_description); }
  if ("assigned_skill" in input) { setClauses.push("assigned_skill = ?"); params.push(input.assigned_skill ?? null); }
  if (input.enabled !== undefined) { setClauses.push("enabled = ?"); params.push(input.enabled ? 1 : 0); }

  if (input.cron_expression !== undefined) {
    setClauses.push("cron_expression = ?");
    params.push(input.cron_expression);
    // Recompute next_run_at when the cron expression changes.
    const nextRun = computeNextRun(input.cron_expression);
    setClauses.push("next_run_at = ?");
    params.push(nextRun ? nextRun.toISOString() : null);
  }

  if (setClauses.length === 0) {
    return getSchedule(id);
  }

  params.push(id);
  const sql = `UPDATE ops_schedules SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`;
  const row = db.prepare(sql).get(...params) as Schedule | undefined;
  return row ?? null;
}

export async function deleteSchedule(id: number): Promise<boolean> {
  const db = await ensureReady();
  const result = prepTasksCached(
    db,
    "DELETE FROM ops_schedules WHERE id = ?"
  ).run(id);
  return result.changes > 0;
}
