import "server-only";
import path from "path";
import type DatabaseT from "better-sqlite3";
import { WORKTREE_SEP } from "../scanner/worktreeCheck";
import { initTasksDb } from "../tasksDb/migrations";
import { getTasksDb, prepTasksCached, isTasksDbShutdownClosed } from "../tasksDb/connection";
import { computeNextRun } from "./cron";
import type {
  Task,
  TaskStatus,
  TaskDecision,
  TaskDependency,
  Schedule,
  Swarm,
  SwarmStatus,
  CreateTaskInput,
  CreateSwarmInput,
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

  let createdTask: Task;
  const txn = db.transaction(() => {
    createdTask = db
      .prepare(
        `INSERT INTO ops_tasks
          (title, description, priority, quadrant, assigned_skill, model,
           execution_mode, scheduled_for, requires_approval, risk_level, dry_run, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
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

    // Insert blocker edges inside the same transaction.
    // Inlined rather than calling addDependency (which owns its own transaction).
    // Cycle detection is skipped: createdTask.id is brand-new, so no existing
    // edge can point back to it — a cycle is impossible for fresh tasks.
    if (input.blockedBy && input.blockedBy.length > 0) {
      const insertDep = prepTasksCached(db,
        `INSERT INTO task_dependencies (task_id, blocker_id) VALUES (?, ?)
         ON CONFLICT(task_id, blocker_id) DO NOTHING`
      );
      for (const blockerId of input.blockedBy) {
        if (blockerId === createdTask.id) throw new CycleError(createdTask.id, blockerId);
        insertDep.run(createdTask.id, blockerId);
      }
    }
  });
  txn();
  return createdTask!;
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
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies td
           JOIN ops_tasks bt ON bt.id = td.blocker_id
           WHERE td.task_id = ops_tasks.id AND (
             (ops_tasks.swarm_role IS NULL OR ops_tasks.swarm_role != 'coordinator')
               AND bt.status != 'done'
             OR
             ops_tasks.swarm_role = 'coordinator'
               AND bt.status NOT IN ('done','failed','cancelled')
           )
         )
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ).get() as Task | undefined;
  return row ?? null;
}

/**
 * All tasks currently in `status='running'`. At dispatcher boot these are rows
 * left over from a previous server instance (their supervising process — and
 * the `child.on('close')` handler that would have recorded completion — is
 * gone), which the boot reconcile resolves. Read-only; safe to call anytime.
 */
export async function listRunningTasks(): Promise<Task[]> {
  const db = await ensureReady();
  return prepTasksCached(
    db,
    "SELECT * FROM ops_tasks WHERE status = 'running'"
  ).all() as Task[];
}

/**
 * Requeue a task that was claimed (`status='running'`) but whose spawn was
 * abandoned before it started — specifically, the dispatcher stopping mid-tick
 * during shutdown (A2). Flips it back to `pending` and clears the claim fields
 * (`started_at`, `session_id`) so the next boot's dispatcher picks it up,
 * instead of leaving it stranded `running` forever (crash recovery only sweeps
 * PID files for *spawned* processes — a claimed-but-never-spawned row has no
 * PID to sweep). Guarded on `status='running'` so it can't resurrect a task
 * that completed in the meantime. Returns the requeued task, or null when no
 * matching running row exists.
 */
export async function requeueRunningTask(id: number): Promise<Task | null> {
  const db = await ensureReady();
  const row = prepTasksCached(
    db,
    `UPDATE ops_tasks
     SET status = 'pending',
         started_at = NULL,
         session_id = NULL
     WHERE id = ? AND status = 'running'
     RETURNING *`
  ).get(id) as Task | undefined;
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
       AND (scheduled_for IS NULL OR scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       AND NOT EXISTS (
         SELECT 1 FROM task_dependencies td
         JOIN ops_tasks bt ON bt.id = td.blocker_id
         WHERE td.task_id = ops_tasks.id AND (
           (ops_tasks.swarm_role IS NULL OR ops_tasks.swarm_role != 'coordinator')
             AND bt.status != 'done'
           OR
           ops_tasks.swarm_role = 'coordinator'
             AND bt.status NOT IN ('done','failed','cancelled')
         )
       )`
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
  if (isTasksDbShutdownClosed()) return; // A2: no writes after the DB is closed for shutdown
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
  // A2: a task whose child exits after the DB was closed for shutdown must not
  // re-open it — no-op cleanly; the next boot's reconcile settles the row from
  // PID/exit evidence (same contract as a crash).
  if (isTasksDbShutdownClosed()) return null;
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
  if (isTasksDbShutdownClosed()) return null; // A2: no writes after shutdown close
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

/** Per-task count of open decisions (kind = 'decision', undecided). Used by /api/kanban for card badges. */
export async function countOpenDecisionsByTask(): Promise<Map<number, number>> {
  const db = await ensureReady();
  const rows = db.prepare(
    `SELECT task_id, COUNT(*) as n FROM task_decisions
     WHERE kind = 'decision' AND decided_at IS NULL
     GROUP BY task_id`
  ).all() as { task_id: number; n: number }[];
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

// ---------------------------------------------------------------------------
// Task dependencies
// ---------------------------------------------------------------------------

export class CycleError extends Error {
  constructor(taskId: number, blockerId: number) {
    super(`Adding dependency ${taskId}→${blockerId} would create a cycle`);
    this.name = "CycleError";
  }
}

/**
 * Add a blocking relationship: taskId is blocked by blockerId.
 * Runs cycle-prevention DFS inside a transaction. Idempotent on duplicate.
 * Throws CycleError if the edge would close a cycle.
 */
export async function addDependency(taskId: number, blockerId: number): Promise<TaskDependency> {
  if (taskId === blockerId) throw new CycleError(taskId, blockerId);
  const db = await ensureReady();

  let result: TaskDependency | undefined;
  const txn = db.transaction(() => {
    const outgoingStmt = prepTasksCached(db, "SELECT task_id FROM task_dependencies WHERE blocker_id = ?");
    const insertStmt = prepTasksCached(db,
      `INSERT INTO task_dependencies (task_id, blocker_id)
       VALUES (?, ?)
       ON CONFLICT(task_id, blocker_id) DO UPDATE SET created_at = created_at
       RETURNING *`
    );

    // DFS from taskId: if we can reach blockerId, the new edge would close a cycle.
    const visited = new Set<number>();
    const stack = [taskId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === blockerId) throw new CycleError(taskId, blockerId);
      if (visited.has(cur)) continue;
      visited.add(cur);
      const outgoing = outgoingStmt.all(cur) as { task_id: number }[];
      for (const row of outgoing) stack.push(row.task_id);
    }

    result = insertStmt.get(taskId, blockerId) as TaskDependency;
  });
  txn();
  return result!;
}

/** Remove a blocking relationship. Returns true if the edge existed, false if not found. */
export async function removeDependency(taskId: number, blockerId: number): Promise<boolean> {
  const db = await ensureReady();
  const result = prepTasksCached(db,
    "DELETE FROM task_dependencies WHERE task_id = ? AND blocker_id = ?"
  ).run(taskId, blockerId);
  return result.changes > 0;
}

/** Get the direct blockedBy and blocks lists for a single task. */
export async function listDependencies(
  taskId: number
): Promise<{ blockedBy: number[]; blocks: number[] }> {
  const db = await ensureReady();
  const blockedByRows = prepTasksCached(db,
    "SELECT blocker_id FROM task_dependencies WHERE task_id = ?"
  ).all(taskId) as { blocker_id: number }[];
  const blocksRows = prepTasksCached(db,
    "SELECT task_id FROM task_dependencies WHERE blocker_id = ?"
  ).all(taskId) as { task_id: number }[];
  return {
    blockedBy: blockedByRows.map((r) => r.blocker_id),
    blocks: blocksRows.map((r) => r.task_id),
  };
}

/** Return every dependency row. Used by /api/kanban to build per-card blocked state. */
export async function listAllDependencies(): Promise<TaskDependency[]> {
  const db = await ensureReady();
  return prepTasksCached(db,
    "SELECT * FROM task_dependencies ORDER BY created_at ASC"
  ).all() as TaskDependency[];
}

// ---------------------------------------------------------------------------
// Swarms
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "cancelled"]);

type SwarmTaskRow = Pick<Task, "id" | "status" | "output_summary" | "title" | "swarm_role" | "description">;

/** Create a swarm with its member tasks (and optional coordinator) in one transaction. */
export async function createSwarm(
  input: CreateSwarmInput
): Promise<{ swarm: Swarm; tasks: Task[] }> {
  const db = await ensureReady();

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  let swarm!: Swarm;
  const allTasks: Task[] = [];

  const txn = db.transaction(() => {
    swarm = db
      .prepare(
        `INSERT INTO ops_swarms (name, mode, project_path) VALUES (?, ?, ?) RETURNING *`
      )
      .get(input.name, input.mode, input.project_path) as Swarm;

    const insertTask = db.prepare(
      `INSERT INTO ops_tasks
        (title, description, priority, quadrant, assigned_skill, model,
         execution_mode, requires_approval, risk_level, dry_run, metadata,
         swarm_id, swarm_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'low', 0, ?, ?, ?)
       RETURNING *`
    );

    const memberIds: number[] = [];

    for (let i = 0; i < input.members.length; i++) {
      const member = input.members[i];
      let meta: Record<string, unknown>;
      if (input.mode === "worktree") {
        const worktreePath = path.join(
          path.dirname(input.project_path),
          path.basename(input.project_path) + WORKTREE_SEP + slug + "-" + swarm.id + "-" + i
        );
        meta = { worktreePath, projectPath: input.project_path };
      } else {
        meta = { projectPath: input.project_path };
      }
      const task = insertTask.get(
        member.title,
        member.description ?? "",
        3,
        "do",
        member.assigned_skill ?? null,
        member.model ?? null,
        member.execution_mode ?? "stream",
        JSON.stringify(meta),
        swarm.id,
        "member"
      ) as Task;
      allTasks.push(task);
      memberIds.push(task.id);
    }

    if (input.coordinator) {
      const coordTask = insertTask.get(
        input.coordinator.title,
        input.coordinator.description ?? "",
        3,
        "do",
        input.coordinator.assigned_skill ?? null,
        null,
        "stream",
        null,
        swarm.id,
        "coordinator"
      ) as Task;
      allTasks.push(coordTask);

      const insertDep = db.prepare(
        `INSERT INTO task_dependencies (task_id, blocker_id) VALUES (?, ?)
         ON CONFLICT(task_id, blocker_id) DO NOTHING`
      );
      for (const memberId of memberIds) {
        insertDep.run(coordTask.id, memberId);
      }
    }
  });

  txn();
  return { swarm, tasks: allTasks };
}

export async function getSwarm(id: number): Promise<Swarm | null> {
  const db = await ensureReady();
  const row = db
    .prepare("SELECT * FROM ops_swarms WHERE id = ?")
    .get(id) as Swarm | undefined;
  return row ?? null;
}

export async function listSwarms(): Promise<Swarm[]> {
  const db = await ensureReady();
  return db
    .prepare("SELECT * FROM ops_swarms ORDER BY created_at DESC")
    .all() as Swarm[];
}

export async function getSwarmTasks(swarmId: number): Promise<Task[]> {
  const db = await ensureReady();
  return db
    .prepare("SELECT * FROM ops_tasks WHERE swarm_id = ? ORDER BY created_at ASC")
    .all(swarmId) as Task[];
}

/**
 * Recompute and write the aggregate status for a swarm after any member/coordinator changes.
 * When all members become terminal, injects their output summaries into the coordinator description
 * (exactly once, guarded by a marker string in the description).
 */
export async function updateSwarmStatus(swarmId: number): Promise<void> {
  const db = await ensureReady();

  const tasks = db
    .prepare(
      "SELECT id, status, output_summary, title, swarm_role, description FROM ops_tasks WHERE swarm_id = ?"
    )
    .all(swarmId) as SwarmTaskRow[];
  if (tasks.length === 0) return;

  const members = tasks.filter((t) => t.swarm_role === "member");
  const coordinator = tasks.find((t) => t.swarm_role === "coordinator");

  // Inject member summaries into coordinator description once, right before it becomes claimable.
  if (
    coordinator &&
    coordinator.status === "pending" &&
    members.every((t) => TERMINAL_STATUSES.has(t.status))
  ) {
    const withOutput = members.filter((t) => t.output_summary);
    if (
      withOutput.length > 0 &&
      !coordinator.description.includes("<!-- swarm-summaries-injected -->")
    ) {
      const block = [
        "<!-- swarm-summaries-injected -->",
        "## Member Task Outputs",
        ...withOutput.map((m) => `\n### ${m.title} (${m.status})\n${m.output_summary}`),
      ].join("\n\n");
      db.prepare(
        `UPDATE ops_tasks SET description = description || ?
         WHERE id = ? AND status = 'pending'`
      ).run("\n\n" + block, coordinator.id);
    }
  }

  const allTerminal = tasks.every((t) => TERMINAL_STATUSES.has(t.status));
  if (!allTerminal) return;

  let newStatus: SwarmStatus;
  if (coordinator) {
    const cs = coordinator.status;
    newStatus = cs === "done" ? "done" : cs === "failed" ? "failed" : "cancelled";
  } else {
    if (members.every((t) => t.status === "done")) newStatus = "done";
    else if (members.some((t) => t.status === "failed")) newStatus = "failed";
    else newStatus = "cancelled";
  }

  db.prepare(
    `UPDATE ops_swarms
     SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'running'`
  ).run(newStatus, swarmId);
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
