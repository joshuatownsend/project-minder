import { NextResponse } from "next/server";
import { getLiveStatusPayload } from "@/lib/liveStatus";
import { listTasks, countOpenDecisionsByTask, listAllDependencies } from "@/lib/tasks/store";
import { buildBoard } from "@/lib/kanban/buildBoard";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
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
  const { sessions } = await getLiveStatusPayload();

  // Use a fresh timestamp so clients always process the response.
  // The session cache timestamp would cause task updates within the 6 s
  // TTL window to be silently dropped by the client's dedup check.
  const generatedAt = new Date().toISOString();

  // Check feature flag before touching the tasks DB.
  const config = await readConfig();
  const taskDispatcherEnabled = getFlag(config.featureFlags, "taskDispatcher");

  if (!taskDispatcherEnabled) {
    return NextResponse.json(
      buildBoard({ sessions, tasks: [], dispatcherEnabled: false }, generatedAt)
    );
  }

  let tasks: Task[] = [];
  let decisionCounts = new Map<number, number>();
  let blockedByMap = new Map<number, number[]>();
  let blocksMap = new Map<number, number[]>();
  let dispatcherEnabled = true;

  try {
    const allTasks = await listTasks();
    tasks = filterTasksByPeriod(allTasks, period);
    decisionCounts = await countOpenDecisionsByTask();
    const deps = await listAllDependencies();
    for (const dep of deps) {
      if (!blockedByMap.has(dep.task_id)) blockedByMap.set(dep.task_id, []);
      blockedByMap.get(dep.task_id)!.push(dep.blocker_id);
      if (!blocksMap.has(dep.blocker_id)) blocksMap.set(dep.blocker_id, []);
      blocksMap.get(dep.blocker_id)!.push(dep.task_id);
    }
  } catch {
    // tasks.db unavailable (driver missing, DB corrupt)
    dispatcherEnabled = false;
  }

  const snapshot = buildBoard(
    { sessions, tasks, dispatcherEnabled, decisionCounts, blockedByMap, blocksMap },
    generatedAt
  );
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
    // Always include open/active tasks and cancelled (which map to Idle)
    if (
      t.status === "pending" ||
      t.status === "running" ||
      t.status === "awaiting_approval" ||
      t.status === "cancelled"
    ) {
      return true;
    }
    // For done/failed only, filter by completion time
    const anchor = t.completed_at ?? t.started_at ?? t.created_at;
    return new Date(anchor).getTime() >= cutoff;
  });
}
