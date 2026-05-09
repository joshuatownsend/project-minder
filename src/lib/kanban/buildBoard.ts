import type { LiveSession } from "@/lib/types";
import type { Task } from "@/lib/tasks/types";
import { sessionToColumn, taskToColumn } from "./columnMap";
import type { KanbanCard, KanbanColumn, KanbanSnapshot } from "./types";
import { KANBAN_COLUMNS } from "./types";

export interface BuildBoardInput {
  sessions: LiveSession[];
  tasks: Task[];
  dispatcherEnabled: boolean;
  /** Open decision counts per task id. Missing keys default to 0. */
  decisionCounts?: Map<number, number>;
}

export function buildBoard(
  { sessions, tasks, dispatcherEnabled, decisionCounts }: BuildBoardInput,
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
      decisionCount: decisionCounts?.get(t.id) ?? 0,
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

type TaskKanbanCard = Extract<KanbanCard, { kind: "task" }>;

function cardTime(
  card: KanbanCard,
  taskField: (t: TaskKanbanCard) => string | null,
): number {
  if (card.kind === "session") return new Date(card.mtime).getTime();
  const v = taskField(card as TaskKanbanCard);
  return v ? new Date(v).getTime() : new Date((card as TaskKanbanCard).createdAt).getTime();
}

const cardActivityTime   = (c: KanbanCard) => cardTime(c, (t) => t.startedAt);
const cardCompletionTime = (c: KanbanCard) => cardTime(c, (t) => t.completedAt);
const cardCreationTime   = (c: KanbanCard) => cardTime(c, () => null);

function sortColumn(col: KanbanColumn, cards: KanbanCard[]): KanbanCard[] {
  let timeFn: (c: KanbanCard) => number;
  if (col === "working" || col === "waiting") timeFn = cardActivityTime;
  else if (col === "done" || col === "error") timeFn = cardCompletionTime;
  else                                        timeFn = cardCreationTime;
  return [...cards].sort((a, b) => timeFn(b) - timeFn(a));
}
