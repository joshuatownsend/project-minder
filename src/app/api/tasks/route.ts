import { NextResponse } from "next/server";
import { listTasks, createTask } from "@/lib/tasks/store";
import { validateCreateTask } from "@/lib/tasks/validation";
import { isTaskStatus, isTaskQuadrant } from "@/lib/tasks/validation";
import type { TaskListFilter } from "@/lib/tasks/types";
import { initDispatcher } from "@/lib/tasks/dispatcher";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { scanAllProjects } from "@/lib/scanner";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Case-insensitive path equality on Windows (both args already resolved). */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve symlinks so comparison uses the real target — a symlink *inside* a
 * project set could otherwise point *outside* it. Falls back to a plain resolve
 * when the path can't be resolved.
 */
async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The spawner's `taskCwd` uses `metadata.projectPath` as the child's cwd, and
 * this route threads `metadata` from a public request — a cwd-injection sink. So
 * `projectPath`, when set, must be one of the actual scanned projects (the exact
 * set the launcher/picker exposes), compared on realpath'd absolute paths so a
 * symlink or case difference can't slip a foreign directory in. (`worktreePath`
 * is rejected earlier, in validateCreateTask — worktree tasks are created
 * internally, never through this public route.)
 */
async function projectPathError(metadata: unknown): Promise<string | null> {
  if (!metadata || typeof metadata !== "object") return null;
  const { projectPath } = metadata as { projectPath?: unknown };
  if (typeof projectPath !== "string" || projectPath === "") return null;

  let isDir = false;
  try {
    isDir = (await stat(projectPath)).isDirectory();
  } catch {
    return "metadata.projectPath does not exist";
  }
  if (!isDir) return "metadata.projectPath is not a directory";

  const real = await resolveReal(projectPath);
  const { projects } = await scanAllProjects();
  const known = await Promise.all(projects.map((p) => resolveReal(p.path)));
  if (!known.some((k) => samePath(k, real))) {
    return "metadata.projectPath must be a scanned project";
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
