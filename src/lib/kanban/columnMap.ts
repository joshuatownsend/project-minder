import type { LiveSessionStatus } from "@/lib/types";
import type { TaskStatus } from "@/lib/tasks/types";
import type { KanbanColumn } from "./types";

/** Maps a live session's status to a Kanban column.
 *  The session's `SessionStatus` (from JSONL history) is used only for the
 *  `other` live-status case to distinguish done vs errored vs idle sessions. */
export function sessionToColumn(
  liveStatus: LiveSessionStatus,
  /** The session's coarse status from JSONL history analysis. */
  sessionStatus?: string,
): KanbanColumn {
  switch (liveStatus) {
    case "approval":
      return "waiting";
    case "working":
      return "working";
    case "waiting":
      return "idle";
    case "other":
      if (
        sessionStatus === "errored" ||
        sessionStatus === "api-error" ||
        sessionStatus === "cancelled"
      ) {
        return "error";
      }
      if (sessionStatus === "done") {
        return "done";
      }
      return "idle";
    default:
      return assertNeverSession(liveStatus);
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
