import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { findProjectPathBySlug } from "@/lib/projectPath";
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

const EMPTY = { epics: [], inbox: [], total: 0 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Fresh read (not the cache) so a board mutated since the last scan reflects
  // immediately. ?archived=1 serves the companion BOARD.archive.md done lane.
  const archived = request.nextUrl.searchParams.get("archived") === "1";
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
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    invalidateCache();
    return NextResponse.json(updated ?? EMPTY);
  } catch (err) {
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
