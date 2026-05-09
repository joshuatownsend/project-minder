import type { LiveSession } from "@/lib/types";
import type { Task } from "@/lib/tasks/types";
import { sessionToColumn, taskToColumn } from "./columnMap";
import type { KanbanCard, KanbanColumn, KanbanSnapshot } from "./types";
import { KANBAN_COLUMNS } from "./types";

export interface BuildBoardInput {
  sessions: LiveSession[];
  tasks: Task[];
  dispatcherEnabled: boolean;
}

export function buildBoard(
  { sessions, tasks, dispatcherEnabled }: BuildBoardInput,
  generatedAt: string,
): KanbanSnapshot {
  const columns: Record<KanbanColumn, KanbanCard[]> = {
    working: [],
    waiting: [],
    idle: [],
    done: [],
    error: [],
  };

  for (const s of sessions) {
    const column = sessionToColumn(s.status);
    columns[column].push({
      kind: "session",
      sessionId: s.sessionId,
      projectSlug: s.projectSlug,
      projectName: s.projectName,
      worktreeLabel: s.worktreeLabel,
      title: s.projectName + (s.worktreeLabel ? ` (${s.worktreeLabel})` : ""),
      column,
      liveStatus: s.status,
      lastToolName: s.lastToolName,
      mtime: s.mtime,
    });
  }

  for (const t of tasks) {
    const column = taskToColumn(t.status);
    columns[column].push({
      kind: "task",
      taskId: t.id,
      quadrant: t.quadrant,
      title: t.title,
      column,
      assignedSkill: t.assigned_skill,
      model: t.model,
      costUsd: t.cost_usd,
      sessionId: t.session_id,
      decisionCount: 0,
      createdAt: t.created_at,
      startedAt: t.started_at,
      completedAt: t.completed_at,
      cancelled: t.status === "cancelled",
    });
  }

  for (const col of KANBAN_COLUMNS) {
    columns[col] = sortColumn(col, columns[col]);
  }

  return { columns, generatedAt, dispatcherEnabled };
}

function sortColumn(col: KanbanColumn, cards: KanbanCard[]): KanbanCard[] {
  if (col === "working" || col === "waiting") {
    // Newest activity first (sessions by mtime, tasks by started_at then created_at)
    return [...cards].sort((a, b) => {
      const aTime = cardActivityTime(a);
      const bTime = cardActivityTime(b);
      return bTime - aTime;
    });
  }
  if (col === "done" || col === "error") {
    // Newest completion first
    return [...cards].sort((a, b) => {
      const aTime = cardCompletionTime(a);
      const bTime = cardCompletionTime(b);
      return bTime - aTime;
    });
  }
  // idle — newest creation first
  return [...cards].sort((a, b) => {
    const aTime = cardCreationTime(a);
    const bTime = cardCreationTime(b);
    return bTime - aTime;
  });
}

function cardActivityTime(card: KanbanCard): number {
  if (card.kind === "session") return new Date(card.mtime).getTime();
  if (card.startedAt) return new Date(card.startedAt).getTime();
  return new Date(card.createdAt).getTime();
}

function cardCompletionTime(card: KanbanCard): number {
  if (card.kind === "session") return new Date(card.mtime).getTime();
  if (card.completedAt) return new Date(card.completedAt).getTime();
  return new Date(card.createdAt).getTime();
}

function cardCreationTime(card: KanbanCard): number {
  if (card.kind === "session") return new Date(card.mtime).getTime();
  return new Date(card.createdAt).getTime();
}
