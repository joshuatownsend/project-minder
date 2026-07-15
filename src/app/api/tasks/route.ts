import { NextResponse } from "next/server";
import { listTasks, createTask } from "@/lib/tasks/store";
import { validateCreateTask } from "@/lib/tasks/validation";
import { isTaskStatus, isTaskQuadrant } from "@/lib/tasks/validation";
import type { TaskListFilter } from "@/lib/tasks/types";
import { initDispatcher } from "@/lib/tasks/dispatcher";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { readConfig } from "@/lib/config";
import { stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/** True when `child` is `root` or lives under it (case-insensitive on Windows). */
function isWithin(root: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A task's `metadata.projectPath` becomes the spawned agent's cwd (`taskCwd` in
 * the spawner). Two risks are guarded here, because this commit newly threads
 * `metadata` through this public route:
 *   1. A stale/missing path silently falls back to the *server's* own directory,
 *      so an autonomous `claude -p` would run against project-minder itself.
 *   2. An arbitrary existing server directory would let any dashboard-reachable
 *      caller spawn an agent outside the configured project set.
 * So the path must exist, be a directory, and live under the configured dev
 * root (which is where every scanned project — and its worktrees — resides).
 * `worktreePath` is intentionally not checked — the worktree runner creates it.
 */
async function projectPathError(metadata: unknown): Promise<string | null> {
  if (!metadata || typeof metadata !== "object") return null;
  const projectPath = (metadata as { projectPath?: unknown }).projectPath;
  if (typeof projectPath !== "string" || projectPath === "") return null;

  let isDir = false;
  try {
    isDir = (await stat(projectPath)).isDirectory();
  } catch {
    return "metadata.projectPath does not exist";
  }
  if (!isDir) return "metadata.projectPath is not a directory";

  const { devRoot } = await readConfig();
  if (devRoot && !isWithin(devRoot, projectPath)) {
    return "metadata.projectPath must be within the configured dev root";
  }
  return null;
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
