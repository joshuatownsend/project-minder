import { NextResponse } from "next/server";
import { listTasks, createTask } from "@/lib/tasks/store";
import { validateCreateTask } from "@/lib/tasks/validation";
import { isTaskStatus, isTaskQuadrant } from "@/lib/tasks/validation";
import type { TaskListFilter } from "@/lib/tasks/types";
import { initDispatcher } from "@/lib/tasks/dispatcher";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { stat } from "node:fs/promises";

export const dynamic = "force-dynamic";

/**
 * A task's `metadata.projectPath` becomes the spawned agent's cwd (`taskCwd` in
 * the spawner). A stale/missing path there silently falls back to the *server's*
 * own directory, so an autonomous `claude -p` would run against project-minder
 * instead of the intended repo. Reject a non-existent / non-directory
 * `projectPath` up front. (`worktreePath` is intentionally not checked — the
 * worktree runner creates it on demand.)
 */
async function projectPathError(metadata: unknown): Promise<string | null> {
  if (!metadata || typeof metadata !== "object") return null;
  const projectPath = (metadata as { projectPath?: unknown }).projectPath;
  if (typeof projectPath !== "string" || projectPath === "") return null;
  try {
    const st = await stat(projectPath);
    if (!st.isDirectory()) return "metadata.projectPath is not a directory";
    return null;
  } catch {
    return "metadata.projectPath does not exist";
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  // No initDispatcher() here: GET is read-only. Starting the dispatcher (which
  // claims pending tasks and spawns work) from a GET made it CSRF-reachable via
  // an origin-less cross-site request. The dispatcher now starts at server boot
  // (instrumentation-node.ts) and on task creation (POST below).
  try {
    const url = new URL(request.url);
    const filter: TaskListFilter = {};

    const statusParam = url.searchParams.get("status");
    if (statusParam) {
      if (!isTaskStatus(statusParam)) {
        return NextResponse.json({ error: `Invalid status filter: ${statusParam}` }, { status: 400 });
      }
      filter.status = statusParam;
    }

    const quadrantParam = url.searchParams.get("quadrant");
    if (quadrantParam) {
      if (!isTaskQuadrant(quadrantParam)) {
        return NextResponse.json({ error: `Invalid quadrant filter: ${quadrantParam}` }, { status: 400 });
      }
      filter.quadrant = quadrantParam;
    }

    const tasks = await listTasks(filter);
    return NextResponse.json({ tasks });
  } catch (err) {
    console.error("[api/tasks GET]", err);
    return NextResponse.json({ error: "Failed to list tasks" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Demo mode is read-only: every project resolves to a synthetic path, so
  // spawning a real task against it would be incoherent. Block before starting
  // the dispatcher or writing a row.
  const blocked = await demoWriteBlock();
  if (blocked) return blocked;

  initDispatcher();
  try {
    const body = await request.json().catch(() => null);
    const validated = validateCreateTask(body);
    if ("error" in validated) {
      return NextResponse.json(
        { error: validated.error, field: validated.field },
        { status: 400 }
      );
    }
    const pathError = await projectPathError(validated.metadata);
    if (pathError) {
      return NextResponse.json({ error: pathError, field: "metadata.projectPath" }, { status: 400 });
    }
    const task = await createTask(validated);
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error("[api/tasks POST]", err);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
