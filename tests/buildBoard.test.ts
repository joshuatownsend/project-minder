import { describe, it, expect } from "vitest";
import { buildBoard } from "@/lib/kanban/buildBoard";
import type { LiveSession } from "@/lib/types";
import type { Task } from "@/lib/tasks/types";
import { KANBAN_COLUMNS } from "@/lib/kanban/types";

const NOW = "2026-05-08T12:00:00.000Z";

function makeSession(overrides: Partial<LiveSession>): LiveSession {
  return {
    sessionId: "sess-1",
    projectSlug: "my-project",
    projectName: "My Project",
    status: "working",
    mtime: NOW,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 1,
    title: "Do something",
    description: "",
    status: "pending",
    priority: 0,
    quadrant: "do",
    assigned_skill: null,
    model: null,
    execution_mode: "classic",
    scheduled_for: null,
    requires_approval: 0,
    risk_level: "low",
    dry_run: 0,
    schedule_id: null,
    approved_at: null,
    session_id: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    cost_usd: null,
    output_summary: null,
    error_message: null,
    consecutive_failures: 0,
    created_at: NOW,
    metadata: null,
    ...overrides,
  };
}

describe("buildBoard", () => {
  it("returns empty columns for empty inputs", () => {
    const snap = buildBoard({ sessions: [], tasks: [], dispatcherEnabled: true }, NOW);
    for (const col of KANBAN_COLUMNS) {
      expect(snap.columns[col]).toEqual([]);
    }
    expect(snap.dispatcherEnabled).toBe(true);
    expect(snap.generatedAt).toBe(NOW);
  });

  it("routes working session to working column", () => {
    const sess = makeSession({ status: "working" });
    const snap = buildBoard({ sessions: [sess], tasks: [], dispatcherEnabled: true }, NOW);
    expect(snap.columns.working).toHaveLength(1);
    expect(snap.columns.working[0].kind).toBe("session");
  });

  it("routes approval session to waiting column", () => {
    const sess = makeSession({ status: "approval" });
    const snap = buildBoard({ sessions: [sess], tasks: [], dispatcherEnabled: true }, NOW);
    expect(snap.columns.waiting).toHaveLength(1);
  });

  it("routes idle session to idle column", () => {
    const sess = makeSession({ status: "waiting" });
    const snap = buildBoard({ sessions: [sess], tasks: [], dispatcherEnabled: true }, NOW);
    expect(snap.columns.idle).toHaveLength(1);
  });

  it("routes running task to working column", () => {
    const task = makeTask({ status: "running" });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.working).toHaveLength(1);
    expect(snap.columns.working[0].kind).toBe("task");
  });

  it("routes awaiting_approval task to waiting column", () => {
    const task = makeTask({ status: "awaiting_approval" });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.waiting).toHaveLength(1);
  });

  it("routes pending task to idle column", () => {
    const task = makeTask({ status: "pending" });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.idle).toHaveLength(1);
  });

  it("routes cancelled task to idle column with cancelled flag", () => {
    const task = makeTask({ status: "cancelled" });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.idle).toHaveLength(1);
    const card = snap.columns.idle[0];
    expect(card.kind).toBe("task");
    if (card.kind === "task") expect(card.cancelled).toBe(true);
  });

  it("routes done task to done column", () => {
    const task = makeTask({ status: "done", completed_at: NOW });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.done).toHaveLength(1);
  });

  it("routes failed task to error column", () => {
    const task = makeTask({ status: "failed" });
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.error).toHaveLength(1);
  });

  it("mixes sessions and tasks in same column", () => {
    const sess = makeSession({ status: "working" });
    const task = makeTask({ status: "running" });
    const snap = buildBoard({ sessions: [sess], tasks: [task], dispatcherEnabled: true }, NOW);
    expect(snap.columns.working).toHaveLength(2);
  });

  it("sorts working column newest-activity first", () => {
    const older = makeSession({
      sessionId: "old",
      status: "working",
      mtime: "2026-05-08T10:00:00.000Z",
    });
    const newer = makeSession({
      sessionId: "new",
      status: "working",
      mtime: "2026-05-08T11:00:00.000Z",
    });
    const snap = buildBoard({ sessions: [older, newer], tasks: [], dispatcherEnabled: true }, NOW);
    expect(snap.columns.working[0].kind === "session" && (snap.columns.working[0] as any).sessionId).toBe("new");
  });

  it("sorts done column newest-completion first", () => {
    const earlier = makeTask({
      id: 1,
      status: "done",
      completed_at: "2026-05-08T10:00:00.000Z",
    });
    const later = makeTask({
      id: 2,
      status: "done",
      completed_at: "2026-05-08T11:00:00.000Z",
    });
    const snap = buildBoard({ sessions: [], tasks: [earlier, later], dispatcherEnabled: true }, NOW);
    expect(snap.columns.done[0].kind === "task" && (snap.columns.done[0] as any).taskId).toBe(2);
  });

  it("populates decisionCount from decisionCounts map", () => {
    const task = makeTask({ id: 42, status: "running" });
    const counts = new Map([[42, 3]]);
    const snap = buildBoard({ sessions: [], tasks: [task], dispatcherEnabled: true, decisionCounts: counts }, NOW);
    const card = snap.columns.working[0];
    expect(card.kind).toBe("task");
    if (card.kind === "task") expect(card.decisionCount).toBe(3);
  });

  it("sets dispatcherEnabled=false when passed false", () => {
    const snap = buildBoard({ sessions: [], tasks: [], dispatcherEnabled: false }, NOW);
    expect(snap.dispatcherEnabled).toBe(false);
  });

  it("session card includes liveStatus and worktreeLabel", () => {
    const sess = makeSession({
      status: "approval",
      worktreeLabel: "feature-branch",
    });
    const snap = buildBoard({ sessions: [sess], tasks: [], dispatcherEnabled: true }, NOW);
    const card = snap.columns.waiting[0];
    expect(card.kind).toBe("session");
    if (card.kind === "session") {
      expect(card.liveStatus).toBe("approval");
      expect(card.worktreeLabel).toBe("feature-branch");
    }
  });
});
