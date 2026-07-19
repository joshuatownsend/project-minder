import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { demoMode } from "@/lib/demo/demoMode";
import { demoProjects } from "@/lib/demo/projects";
import { scanBoardMd, scanBoardArchive } from "@/lib/scanner/boardMd";
import {
  addIssue,
  addEpic,
  setIssueStatus,
  editIssue,
  moveIssue,
  reorderIssue,
  promoteTodoToBoard,
  BoardWriteError,
} from "@/lib/boardWriter";
import { promoteBoardIssueToTask } from "@/lib/tasks/boardDelegation";
import { checkWslRoot, parseWslUncPath, WslUnavailableError } from "@/lib/wsl";

/** Never-wake preflight for the fresh-read lane: reading BOARD.md under a
 *  stopped WSL distro would auto-start its VM. Null means "go ahead". */
async function wslReadBlocked(projectPath: string) {
  if (!parseWslUncPath(projectPath)) return null;
  const check = await checkWslRoot(projectPath);
  return check && !check.ok ? check : null;
}

const EMPTY = { epics: [], inbox: [], total: 0 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const archived = request.nextUrl.searchParams.get("archived") === "1";

  // Demo mode: this route fresh-reads BOARD.md from disk, so without a guard it
  // would read the fake C:\dev\<slug> path (empty off-Windows, or a real local
  // BOARD.md on Windows) and clobber the fixture board the tab already rendered.
  // Serve the synthetic board directly; the archive lane has no fixture.
  if (await demoMode()) {
    if (archived) return NextResponse.json(EMPTY);
    const p = demoProjects(Date.now()).find((dp) => dp.slug === slug);
    return NextResponse.json(p?.board ?? EMPTY);
  }

  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const blocked = await wslReadBlocked(projectPath);
  if (blocked) {
    return NextResponse.json(
      { error: new WslUnavailableError(blocked).message },
      { status: 503 },
    );
  }

  // Fresh read (not the cache) so a board mutated since the last scan reflects
  // immediately. ?archived=1 serves the companion BOARD.archive.md done lane.
  const info = archived
    ? await scanBoardArchive(projectPath)
    : await scanBoardMd(projectPath);
  return NextResponse.json(info ?? EMPTY);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  // Demo projects have fake C:\dev paths — never resolve a write target to one.
  if (await demoMode()) {
    return NextResponse.json({ error: "Read-only in demo mode." }, { status: 409 });
  }
  // findProjectPathBySlug validates the slug against scanned projects; the board
  // writer canonicalizes again internally, so a worktree path can't slip through.
  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    let updated;
    switch (body.action) {
      case "addIssue":
        if (!body.issue?.title) {
          return NextResponse.json(
            { error: "issue.title required" },
            { status: 400 },
          );
        }
        updated = await addIssue(projectPath, body.issue);
        break;
      case "addEpic":
        if (!body.title) {
          return NextResponse.json({ error: "title required" }, { status: 400 });
        }
        updated = await addEpic(projectPath, body.title, {
          status: body.status,
          priority: body.priority,
          description: body.description,
        });
        break;
      case "setStatus":
        if (!body.id || !body.status) {
          return NextResponse.json(
            { error: "id and status required" },
            { status: 400 },
          );
        }
        updated = await setIssueStatus(projectPath, body.id, body.status);
        break;
      case "editIssue":
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        updated = await editIssue(projectPath, body.id, body.patch ?? {});
        break;
      case "move":
        if (!body.id || !body.toEpicId) {
          return NextResponse.json(
            { error: "id and toEpicId required" },
            { status: 400 },
          );
        }
        updated = await moveIssue(projectPath, body.id, body.toEpicId);
        break;
      case "reorder":
        if (!body.id || typeof body.order !== "number") {
          return NextResponse.json(
            { error: "id and numeric order required" },
            { status: 400 },
          );
        }
        updated = await reorderIssue(projectPath, body.id, body.order);
        break;
      case "promoteTodo":
        if (typeof body.lineNumber !== "number") {
          return NextResponse.json(
            { error: "numeric lineNumber required" },
            { status: 400 },
          );
        }
        updated = await promoteTodoToBoard({
          projectPath,
          lineNumber: body.lineNumber,
          epicId: body.epicId,
          status: body.status,
          priority: body.priority,
          labels: body.labels,
          checkOff: body.checkOff,
        });
        break;
      case "promoteToTask": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        const result = await promoteBoardIssueToTask({
          projectPath,
          issueId: body.id,
          assignedSkill: body.assignedSkill,
          model: body.model,
          priority: body.priority,
          riskLevel: body.riskLevel,
          sessionId: body.sessionId,
        });
        // Bridges into ~/.minder/tasks.db; returns { taskId, board } rather
        // than the bare BoardInfo, so it short-circuits the shared response.
        invalidateCache();
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    invalidateCache();
    return NextResponse.json(updated ?? EMPTY);
  } catch (err) {
    if (err instanceof WslUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof BoardWriteError) {
      // NOT_FOUND/BAD_TARGET → the target row/epic doesn't exist (404);
      // EMPTY_TITLE → malformed request (400).
      const status =
        err.code === "NOT_FOUND" || err.code === "BAD_TARGET" ? 404 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    return NextResponse.json(
      { error: "Board mutation failed" },
      { status: 500 },
    );
  }
}
