import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

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

  // v2: delegated-todo quadrant + metadata column
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
    CREATE INDEX IF NOT EXISTS ix_task_decisions_task ON task_decisions(task_id);
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

  // v5: ops_swarms + swarm columns on ops_tasks
  runSql(db, `
    CREATE TABLE IF NOT EXISTS ops_swarms (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      mode         TEXT    NOT NULL CHECK (mode IN ('worktree','shared')),
      project_path TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','done','failed','cancelled')),
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT
    );
    ALTER TABLE ops_tasks ADD COLUMN swarm_id INTEGER REFERENCES ops_swarms(id) ON DELETE SET NULL;
    ALTER TABLE ops_tasks ADD COLUMN swarm_role TEXT CHECK (swarm_role IN ('member','coordinator') OR swarm_role IS NULL);
    CREATE INDEX IF NOT EXISTS ix_tasks_swarm ON ops_tasks(swarm_id) WHERE swarm_id IS NOT NULL
  `);

  return db;
}

describe.skipIf(!Database)("swarm store", () => {
  let store: typeof import("@/lib/tasks/store");

  beforeAll(async () => {
    memDb = buildMemDb();
    store = await import("@/lib/tasks/store");
  });

  afterAll(() => {
    memDb?.close();
    vi.restoreAllMocks();
  });

  it("createSwarm (shared) creates swarm + member tasks", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Test swarm",
      mode: "shared",
      project_path: "C:\\dev\\test-project",
      members: [
        { title: "Member A" },
        { title: "Member B" },
      ],
    });
    expect(swarm.id).toBeGreaterThan(0);
    expect(swarm.name).toBe("Test swarm");
    expect(swarm.mode).toBe("shared");
    expect(swarm.status).toBe("running");
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.swarm_id === swarm.id)).toBe(true);
    expect(tasks.every((t) => t.swarm_role === "member")).toBe(true);
    // Shared mode: no worktreePath in metadata
    for (const t of tasks) {
      const meta = t.metadata ? JSON.parse(t.metadata) : null;
      expect(meta?.worktreePath).toBeUndefined();
    }
  });

  it("createSwarm (worktree) stores worktreePath in member metadata", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Worktree swarm",
      mode: "worktree",
      project_path: "C:\\dev\\my-project",
      members: [
        { title: "Wt member 1" },
        { title: "Wt member 2" },
      ],
    });
    expect(swarm.mode).toBe("worktree");
    for (let i = 0; i < tasks.length; i++) {
      const meta = JSON.parse(tasks[i].metadata!) as { worktreePath?: string; projectPath?: string };
      expect(meta.worktreePath).toContain("--claude-worktrees-");
      expect(meta.projectPath).toBe("C:\\dev\\my-project");
    }
  });

  it("createSwarm with coordinator creates dep edges and coordinator task", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Coord swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "M1" }, { title: "M2" }],
      coordinator: { title: "Coord" },
    });
    const members = tasks.filter((t) => t.swarm_role === "member");
    const coord = tasks.find((t) => t.swarm_role === "coordinator");
    expect(coord).toBeDefined();
    expect(members).toHaveLength(2);

    // Verify dependency rows exist
    const deps = memDb!
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ?")
      .all(coord!.id) as { blocker_id: number }[];
    expect(deps).toHaveLength(2);
    const memberIds = members.map((m) => m.id);
    expect(deps.map((d) => d.blocker_id).sort()).toEqual(memberIds.sort());

    // Cancel all other pending tasks so only coord + members remain
    memDb!.prepare(
      `UPDATE ops_tasks SET status = 'cancelled'
       WHERE status = 'pending' AND id NOT IN (${members.map(() => "?").join(",")}, ${coord!.id})`
    ).run(...members.map((m) => m.id));

    // Coordinator not claimable while members pending
    const claimedBefore = await store.claimPendingTask();
    // Only members (pending, unblocked) or null should be returned — not the coordinator
    if (claimedBefore) {
      expect(claimedBefore.swarm_role).not.toBe("coordinator");
      // Reset it back
      memDb!.prepare(`UPDATE ops_tasks SET status = 'pending', started_at = NULL WHERE id = ?`).run(claimedBefore.id);
    }

    // Mark all members done → coordinator should become claimable
    for (const m of members) {
      memDb!.prepare(`UPDATE ops_tasks SET status = 'cancelled' WHERE id = ?`).run(m.id);
    }
    const claimedAfterDone = await store.claimPendingTask();
    expect(claimedAfterDone?.id).toBe(coord!.id);
    // Clean up: reset coordinator
    memDb!.prepare(`UPDATE ops_tasks SET status = 'pending', started_at = NULL WHERE id = ?`).run(coord!.id);

    void swarm;
  });

  it("coordinator claimable when members failed (all-terminal guard)", async () => {
    const { tasks } = await store.createSwarm({
      name: "Failed members swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "FM1" }, { title: "FM2" }],
      coordinator: { title: "FC" },
    });
    const members = tasks.filter((t) => t.swarm_role === "member");
    const coord = tasks.find((t) => t.swarm_role === "coordinator")!;

    // Mark one member failed, one cancelled
    memDb!.prepare(`UPDATE ops_tasks SET status = 'running' WHERE id = ?`).run(members[0].id);
    memDb!.prepare(`UPDATE ops_tasks SET status = 'failed' WHERE id = ?`).run(members[0].id);
    memDb!.prepare(`UPDATE ops_tasks SET status = 'cancelled' WHERE id = ?`).run(members[1].id);

    // Cancel all other pending tasks so only coord remains
    memDb!.prepare(
      `UPDATE ops_tasks SET status = 'cancelled' WHERE status = 'pending' AND id != ?`
    ).run(coord.id);

    // All members terminal (failed/cancelled) → coordinator should be claimable
    const claimed = await store.claimPendingTask();
    expect(claimed?.id).toBe(coord.id);
    // Clean up
    memDb!.prepare(`UPDATE ops_tasks SET status = 'pending', started_at = NULL WHERE id = ?`).run(coord.id);
  });

  it("getSwarmTasks returns tasks for the swarm", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Get tasks swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "GT1" }, { title: "GT2" }],
    });
    const fetched = await store.getSwarmTasks(swarm.id);
    expect(fetched).toHaveLength(tasks.length);
    expect(fetched.every((t) => t.swarm_id === swarm.id)).toBe(true);
  });

  it("updateSwarmStatus sets done when all members done (no coordinator)", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Status update swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "S1" }, { title: "S2" }],
    });
    for (const t of tasks) {
      memDb!.prepare(`UPDATE ops_tasks SET status = 'running' WHERE id = ?`).run(t.id);
      memDb!.prepare(`UPDATE ops_tasks SET status = 'done', output_summary = ? WHERE id = ?`).run("OK", t.id);
    }
    await store.updateSwarmStatus(swarm.id);
    const updated = await store.getSwarm(swarm.id);
    expect(updated?.status).toBe("done");
    expect(updated?.completed_at).toBeTruthy();
  });

  it("updateSwarmStatus sets failed when any member failed (no coordinator)", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Failed swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "F1" }, { title: "F2" }],
    });
    memDb!.prepare(`UPDATE ops_tasks SET status = 'running' WHERE id = ?`).run(tasks[0].id);
    memDb!.prepare(`UPDATE ops_tasks SET status = 'failed' WHERE id = ?`).run(tasks[0].id);
    memDb!.prepare(`UPDATE ops_tasks SET status = 'cancelled' WHERE id = ?`).run(tasks[1].id);
    await store.updateSwarmStatus(swarm.id);
    const updated = await store.getSwarm(swarm.id);
    expect(updated?.status).toBe("failed");
  });

  it("updateSwarmStatus injects member summaries into coordinator description once", async () => {
    const { swarm, tasks } = await store.createSwarm({
      name: "Inject swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "IM1" }, { title: "IM2" }],
      coordinator: { title: "IC", description: "Coordinate" },
    });
    const members = tasks.filter((t) => t.swarm_role === "member");
    const coord = tasks.find((t) => t.swarm_role === "coordinator")!;

    for (const m of members) {
      memDb!
        .prepare(`UPDATE ops_tasks SET status = 'running' WHERE id = ?`)
        .run(m.id);
      memDb!
        .prepare(`UPDATE ops_tasks SET status = 'done', output_summary = ? WHERE id = ?`)
        .run(`Output of ${m.title}`, m.id);
    }

    await store.updateSwarmStatus(swarm.id);

    const updatedCoord = memDb!
      .prepare("SELECT description FROM ops_tasks WHERE id = ?")
      .get(coord.id) as { description: string };

    expect(updatedCoord.description).toContain("## Member Task Outputs");
    expect(updatedCoord.description).toContain("IM1");
    expect(updatedCoord.description).toContain("IM2");

    // Call again — should not duplicate the block
    await store.updateSwarmStatus(swarm.id);
    const afterSecond = memDb!
      .prepare("SELECT description FROM ops_tasks WHERE id = ?")
      .get(coord.id) as { description: string };
    const count = (afterSecond.description.match(/## Member Task Outputs/g) ?? []).length;
    expect(count).toBe(1);

    void swarm;
  });

  it("listSwarms returns all swarms", async () => {
    const before = await store.listSwarms();
    await store.createSwarm({
      name: "List test swarm",
      mode: "shared",
      project_path: "C:\\dev\\test",
      members: [{ title: "L1" }, { title: "L2" }],
    });
    const after = await store.listSwarms();
    expect(after.length).toBe(before.length + 1);
  });
});
