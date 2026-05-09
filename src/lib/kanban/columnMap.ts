import type { LiveSessionStatus } from "@/lib/types";
import type { TaskStatus } from "@/lib/tasks/types";
import type { KanbanColumn } from "./types";

/** Maps a live session's status to a Kanban column.
 *  Sessions sourced from getLiveStatusPayload() only carry LiveSessionStatus —
 *  no terminal-state signal — so they can only appear in Working/Waiting/Idle. */
export function sessionToColumn(liveStatus: LiveSessionStatus): KanbanColumn {
  switch (liveStatus) {
    case "approval": return "waiting";
    case "working":  return "working";
    case "waiting":  return "idle";
    case "other":    return "idle";
    default:         return assertNeverSession(liveStatus);
  }
}

/** Maps a task's status to a Kanban column. */
export function taskToColumn(status: TaskStatus): KanbanColumn {
  switch (status) {
    case "running":
      return "working";
    case "awaiting_approval":
      return "waiting";
    case "pending":
      return "idle";
    case "cancelled":
      return "idle";
    case "done":
      return "done";
    case "failed":
      return "error";
    default:
      return assertNeverTask(status);
  }
}

function assertNeverSession(x: never): KanbanColumn {
  console.warn("[columnMap] Unknown LiveSessionStatus:", x);
  return "idle";
}

function assertNeverTask(x: never): KanbanColumn {
  console.warn("[columnMap] Unknown TaskStatus:", x);
  return "idle";
}
