import "server-only";
import type DatabaseT from "better-sqlite3";
import { initTasksDb } from "../tasksDb/migrations";
import { getTasksDb, prepTasksCached } from "../tasksDb/connection";
import { computeNextRun } from "./cron";
import type {
  Task,
  TaskDecision,
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
  if (filter?.source === "todo") {
    conditions.push("quadrant = 'delegated-todo'");
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
  const metadataJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
  const result = prepTasksCached(
    db,
    `INSERT INTO ops_tasks
      (title, description, priority, quadrant, assigned_skill, model,
       execution_mode, scheduled_for, requires_approval, risk_level, dry_run, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).get(
    input.title,
    input.description ?? "",
    input.priority ?? 3,
    input.quadrant ?? "do",
    input.assigned_skill ?? null,
    input.model ?? null,
    input.execution_mode ?? "classic",
    input.scheduled_for ?? null,
    input.requires_approval ? 1 : 0,
    input.risk_level ?? "low",
    input.dry_run ? 1 : 0,
    metadataJson
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
 * Atomically claim the next pending task that does NOT require approval.
 * Tasks with requires_approval=1 are promoted to awaiting_approval instead.
 * Returns the claimed (now running) task, or null if no eligible tasks exist.
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
         AND requires_approval = 0
         AND (scheduled_for IS NULL OR scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ).get() as Task | undefined;
  return row ?? null;
}

/**
 * Promote tasks with requires_approval=1 from pending → awaiting_approval.
 * Called on each dispatcher tick before claiming runnable tasks.
 * Returns the number of tasks promoted.
 */
export async function promoteApprovalTasks(): Promise<number> {
  const db = await ensureReady();
  const result = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'awaiting_approval'
     WHERE status = 'pending'
       AND requires_approval = 1
       AND approved_at IS NULL
       AND (scheduled_for IS NULL OR scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).run();
  return result.changes;
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

// ---------------------------------------------------------------------------
// Dispatcher lifecycle helpers
// ---------------------------------------------------------------------------

/** Mark awaiting_approval → pending; set approved_at and clear requires_approval so dispatcher can claim it. */
export async function approveTask(id: number): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'pending',
         approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         requires_approval = 0
     WHERE id = ? AND status = 'awaiting_approval'
     RETURNING *`
  ).get(id) as Task | undefined;
  return row ?? null;
}

/** Reset failed task to pending; clear all output fields. Returns null if task not found or wrong status. */
export async function rerunTask(id: number): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'pending',
         error_message = NULL,
         started_at = NULL,
         completed_at = NULL,
         duration_ms = NULL,
         cost_usd = NULL,
         output_summary = NULL,
         session_id = NULL
     WHERE id = ? AND status = 'failed'
     RETURNING *`
  ).get(id) as Task | undefined;
  return row ?? null;
}

/** Write session_id mid-run (before completeTask is called). Fire-and-forget safe. */
export async function setSessionId(id: number, sessionId: string): Promise<void> {
  const db = await ensureReady();
  prepTasksCached(db, "UPDATE ops_tasks SET session_id = ? WHERE id = ? AND status = 'running'").run(sessionId, id);
}

export interface CompleteTaskInput {
  output_summary?: string;
  duration_ms?: number;
  cost_usd?: number;
}

/** Mark a running task as done with captured output. */
export async function completeTask(id: number, result: CompleteTaskInput): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'done',
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         consecutive_failures = 0,
         output_summary = ?,
         duration_ms = ?,
         cost_usd = ?
     WHERE id = ? AND status = 'running'
     RETURNING *`
  ).get(
    result.output_summary ?? null,
    result.duration_ms ?? null,
    result.cost_usd ?? null,
    id
  ) as Task | undefined;
  return row ?? null;
}

export interface FailTaskInput {
  error_message?: string;
  duration_ms?: number;
}

/** Mark a running task as failed. Increments consecutive_failures. */
export async function failTask(id: number, info: FailTaskInput): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'failed',
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         consecutive_failures = consecutive_failures + 1,
         error_message = ?,
         duration_ms = ?
     WHERE id = ? AND status = 'running'
     RETURNING *`
  ).get(
    info.error_message ?? null,
    info.duration_ms ?? null,
    id
  ) as Task | undefined;
  return row ?? null;
}

/**
 * Insert a DECISION or INBOX event from a running stream task.
 * The partial UNIQUE(task_id, kind, prompt) WHERE kind='decision' AND decided_at IS NULL
 * prevents duplicate DECISION markers from creating duplicate rows.
 * Duplicate inserts are silently ignored via ON CONFLICT DO NOTHING.
 */
export async function recordDecision(
  taskId: number,
  sessionId: string | null,
  kind: "decision" | "inbox",
  prompt: string,
  choices?: string[] | null
): Promise<TaskDecision | null> {
  const db = await ensureReady();
  const choicesJson = choices && choices.length > 0 ? JSON.stringify(choices) : null;
  const row = db.prepare(
    `INSERT INTO task_decisions (task_id, session_id, kind, prompt, choices)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING *`
  ).get(taskId, sessionId ?? null, kind, prompt, choicesJson) as TaskDecision | undefined;
  return row ?? null;
}

/**
 * Mark an open decision as resolved with the user's answer.
 * Returns null if the decision was already decided or doesn't exist.
 */
export async function decideTask(
  decisionId: number,
  decisionText: string
): Promise<TaskDecision | null> {
  const db = await ensureReady();
  const row = db.prepare(
    `UPDATE task_decisions
     SET decision_text = ?, decided_at = unixepoch()
     WHERE id = ? AND decided_at IS NULL
     RETURNING *`
  ).get(decisionText, decisionId) as TaskDecision | undefined;
  return row ?? null;
}

/** List all open (undecided) decisions across all tasks. */
export async function listOpenDecisions(taskId?: number): Promise<TaskDecision[]> {
  const db = await ensureReady();
  if (taskId !== undefined) {
    return db.prepare(
      `SELECT * FROM task_decisions WHERE task_id = ? AND decided_at IS NULL ORDER BY created_at ASC`
    ).all(taskId) as TaskDecision[];
  }
  return db.prepare(
    `SELECT d.*, t.title as task_title FROM task_decisions d
     JOIN ops_tasks t ON t.id = d.task_id
     WHERE d.decided_at IS NULL
     ORDER BY d.created_at ASC`
  ).all() as TaskDecision[];
}

/** Recent inbox messages (inbox entries, regardless of decided_at). */
export async function listInbox(limit = 50): Promise<TaskDecision[]> {
  const db = await ensureReady();
  return db.prepare(
    `SELECT d.*, t.title as task_title FROM task_decisions d
     JOIN ops_tasks t ON t.id = d.task_id
     WHERE d.kind = 'inbox'
     ORDER BY d.created_at DESC
     LIMIT ?`
  ).all(limit) as TaskDecision[];
}

/** Count open decisions (kind = 'decision' only). */
export async function countOpenDecisions(): Promise<number> {
  const db = await ensureReady();
  const row = prepTasksCached(db,
    `SELECT COUNT(*) as n FROM task_decisions WHERE kind = 'decision' AND decided_at IS NULL`
  ).get() as { n: number };
  return row.n;
}

/** Count inbox messages (kind = 'inbox', all time — used as a monotone change signal). */
export async function countInboxMessages(): Promise<number> {
  const db = await ensureReady();
  const row = prepTasksCached(db,
    `SELECT COUNT(*) as n FROM task_decisions WHERE kind = 'inbox'`
  ).get() as { n: number };
  return row.n;
}

/** Count decisions created after sinceEpoch (Unix seconds). Used by pulse for per-client edge-triggering. */
export async function countNewDecisions(sinceEpoch: number): Promise<number> {
  const db = await ensureReady();
  const row = prepTasksCached(db,
    `SELECT COUNT(*) as n FROM task_decisions WHERE kind = 'decision' AND created_at > ?`
  ).get(sinceEpoch) as { n: number };
  return row.n;
}

/**
 * Materialize due schedules into ops_tasks rows.
 * Wrapped in a serialized transaction (DEFERRED) — safe because the dispatcher is single-threaded JS.
 * Returns the number of tasks created.
 */
export async function materializeSchedules(): Promise<number> {
  const db = await ensureReady();
  const now = new Date().toISOString();

  const insertScheduleTask = db.prepare(
    `INSERT INTO ops_tasks (title, description, assigned_skill, schedule_id)
     VALUES (?, ?, ?, ?)`
  );
  const updateNextRun = db.prepare(
    `UPDATE ops_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`
  );
  const selectDue = db.prepare(
    `SELECT * FROM ops_schedules
     WHERE enabled = 1
       AND (next_run_at IS NULL OR next_run_at <= ?)
     ORDER BY next_run_at ASC`
  );

  let count = 0;
  const txn = db.transaction(() => {
    const due = selectDue.all(now) as Schedule[];
    for (const sched of due) {
      insertScheduleTask.run(
        sched.task_title,
        sched.task_description ?? "",
        sched.assigned_skill ?? null,
        sched.id
      );
      const next = computeNextRun(sched.cron_expression);
      updateNextRun.run(now, next ? next.toISOString() : null, sched.id);
      count++;
    }
  });
  txn();
  return count;
}
