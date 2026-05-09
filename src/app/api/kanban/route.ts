import { NextResponse } from "next/server";
import { getLiveStatusPayload } from "@/lib/liveStatus";
import { listTasks } from "@/lib/tasks/store";
import { buildBoard } from "@/lib/kanban/buildBoard";
import type { KanbanPeriod } from "@/lib/kanban/types";
import type { Task } from "@/lib/tasks/types";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set<KanbanPeriod>(["last24h", "last7d", "all"]);

// Polling cadence is intentionally 6 s on the client so this route hits
// getLiveStatusPayload()'s 6 s cache as a near-100% cache hit.
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period") ?? "last24h";

  if (!VALID_PERIODS.has(periodParam as KanbanPeriod)) {
    return NextResponse.json(
      { error: `Invalid period. Must be one of: ${[...VALID_PERIODS].join(", ")}` },
      { status: 400 }
    );
  }

  const period = periodParam as KanbanPeriod;

  // Sessions — always include all live sessions regardless of period.
  // getLiveStatusPayload() is 6 s in-memory cached + single-flighted.
  const { sessions, generatedAt } = await getLiveStatusPayload();

  let tasks: Task[] = [];
  let dispatcherEnabled = true;

  try {
    const allTasks = await listTasks();
    tasks = filterTasksByPeriod(allTasks, period);
  } catch {
    // tasks.db unavailable (driver missing, DB corrupt, or dispatcher disabled)
    dispatcherEnabled = false;
    tasks = [];
  }

  const snapshot = buildBoard({ sessions, tasks, dispatcherEnabled }, generatedAt);
  return NextResponse.json(snapshot);
}

function filterTasksByPeriod(
  tasks: Awaited<ReturnType<typeof listTasks>>,
  period: KanbanPeriod,
) {
  if (period === "all") return tasks;

  const cutoffMs = period === "last24h"
    ? 24 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;

  const cutoff = Date.now() - cutoffMs;

  return tasks.filter((t) => {
    // Always include open/in-progress tasks
    if (
      t.status === "pending" ||
      t.status === "running" ||
      t.status === "awaiting_approval"
    ) {
      return true;
    }
    // For terminal states, filter by completion time or created_at
    const anchor = t.completed_at ?? t.started_at ?? t.created_at;
    return new Date(anchor).getTime() >= cutoff;
  });
}
