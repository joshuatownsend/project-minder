import { NextResponse } from "next/server";
import { listTasks, createTask } from "@/lib/tasks/store";
import { validateCreateTask } from "@/lib/tasks/validation";
import { isTaskStatus, isTaskQuadrant } from "@/lib/tasks/validation";
import type { TaskListFilter } from "@/lib/tasks/types";
import { initDispatcher } from "@/lib/tasks/dispatcher";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { readConfig, getDevRoots } from "@/lib/config";
import { scanAllProjects } from "@/lib/scanner";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/** True when `child` is `root` or lives under it (case-insensitive on Windows). */
function isWithin(root: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Case-insensitive path equality on Windows (both args already resolved). */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve symlinks so containment compares real targets — a symlink *under* a
 * dev root can point *outside* it. Falls back to a plain resolve when the path
 * doesn't exist yet (a worktreePath the runner will create — nothing to follow).
 */
async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A task's cwd is derived from metadata by the spawner: `taskCwd` uses
 * `metadata.projectPath ?? metadata.worktreePath` for classic/stream tasks. This
 * commit newly threads `metadata` through this public route, so both keys are a
 * potential cwd-injection sink:
 *   - `projectPath` must be one of the actual scanned projects (the set the
 *     launcher/picker exposes), resolved through symlinks — not merely an
 *     existing directory, and not any arbitrary sub-folder under a dev root.
 *   - `worktreePath` (rarely set on this public path; the worktree runner
 *     creates it, so it may not exist yet) must at least live under a configured
 *     dev root so it can't point the cwd outside the roots.
 * A stale/absent/foreign path would otherwise let the spawn fall back to the
 * server's own cwd or run an autonomous `claude -p` in an unintended directory.
 */
async function projectPathError(metadata: unknown): Promise<string | null> {
  if (!metadata || typeof metadata !== "object") return null;
  const { projectPath, worktreePath } = metadata as {
    projectPath?: unknown;
    worktreePath?: unknown;
  };

  if (typeof projectPath === "string" && projectPath !== "") {
    let isDir = false;
    try {
      isDir = (await stat(projectPath)).isDirectory();
    } catch {
      return "metadata.projectPath does not exist";
    }
    if (!isDir) return "metadata.projectPath is not a directory";

    // Must match a scanned project (the exact set the picker exposes), compared
    // on realpath'd absolute paths so symlinks/case can't slip a foreign dir in.
    const real = await resolveReal(projectPath);
    const { projects } = await scanAllProjects();
    const known = await Promise.all(projects.map((p) => resolveReal(p.path)));
    if (!known.some((k) => samePath(k, real))) {
      return "metadata.projectPath must be a scanned project";
    }
  }

  if (typeof worktreePath === "string" && worktreePath !== "") {
    const realRoots = await Promise.all(getDevRoots(await readConfig()).map(resolveReal));
    const real = await resolveReal(worktreePath);
    if (realRoots.length > 0 && !realRoots.some((r) => isWithin(r, real))) {
      return "metadata.worktreePath must be within a configured dev root";
    }
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
