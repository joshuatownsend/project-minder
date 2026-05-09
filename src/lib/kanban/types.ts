import type { TaskQuadrant } from "@/lib/tasks/types";

export type KanbanColumn = "working" | "waiting" | "idle" | "done" | "error";

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  "working",
  "waiting",
  "idle",
  "done",
  "error",
];

export const KANBAN_COLUMN_LABELS: Record<KanbanColumn, string> = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  done: "Done",
  error: "Error",
};

export const KANBAN_COLUMN_EMPTY: Record<KanbanColumn, string> = {
  working: "No working items",
  waiting: "Nothing waiting",
  idle: "Nothing idle",
  done: "Nothing done yet",
  error: "No errors",
};

export type KanbanCard =
  | {
      kind: "session";
      sessionId: string;
      projectSlug: string;
      projectName: string;
      worktreeLabel?: string;
      title: string;
      column: KanbanColumn;
      /** The live status from liveStatus.ts — used for dot color. */
      liveStatus: "working" | "approval" | "waiting" | "other";
      lastToolName?: string;
      mtime: string;
    }
  | {
      kind: "task";
      taskId: number;
      quadrant: TaskQuadrant;
      title: string;
      column: KanbanColumn;
      assignedSkill: string | null;
      model: string | null;
      costUsd: number | null;
      sessionId: string | null;
      /** Number of pending decisions for this task. */
      decisionCount: number;
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
      /** True when status is 'cancelled' — rendered de-emphasized. */
      cancelled: boolean;
    };

export type KanbanKindFilter = "all" | "sessions" | "tasks";
export type KanbanPeriod = "last24h" | "last7d" | "all";

export interface KanbanSnapshot {
  columns: Record<KanbanColumn, KanbanCard[]>;
  generatedAt: string;
  dispatcherEnabled: boolean;
}
