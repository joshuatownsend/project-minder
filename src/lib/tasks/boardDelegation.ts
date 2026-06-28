import "server-only";
import path from "path";
import { createTask } from "./store";
import { setIssueStatus, BoardWriteError } from "../boardWriter";
import { scanBoardMd } from "../scanner/boardMd";
import { canonicalProjectDir } from "../canonicalProjectPath";
import type { BoardInfo, BoardIssue } from "../types";
import type { Task, RiskLevel } from "./types";

// ── Board → task bridge (Phase 2, Group A) ─────────────────────────────────
//
// A parallel path to `delegateTodo`: a BOARD.md issue has no `TODO.md` line
// anchor, so it can't reuse the line-keyed TODO promote. Instead we store
// `{sourceType:"board-issue", boardIssueId, projectPath, projectSlug, …}` in the
// task's metadata and reuse the lower-level `createTask`. A two-way, best-effort
// lifecycle keeps the board in sync: promote flips the issue to `doing` (now in
// flight); task completion flips it to `done` (see `onTaskCompleteSyncBoard`).

export interface PromoteBoardIssueInput {
  /** Parent project path (route/MCP resolves slug → path; canonicalized here). */
  projectPath: string;
  /** `i-xxxx` issue id (the `^`-ref without the caret). */
  issueId: string;
  assignedSkill?: string;
  model?: string;
  /** Task priority 1–5 (NOT the board's high/med/low priority). */
  priority?: number;
  riskLevel?: RiskLevel;
  /** Provenance for task.metadata. */
  sessionId?: string;
}

export interface PromoteBoardIssueResult {
  taskId: number;
  /** Board re-parsed after the issue → doing write (undefined if empty). */
  board?: BoardInfo;
}

/** Metadata stamped on a board-sourced task (distinguishes it from TODO.md). */
export interface BoardTaskMeta {
  sourceType: "board-issue";
  boardIssueId: string;
  projectPath: string;
  projectSlug: string;
  sessionId?: string;
  worktree?: string;
}

/** Find an issue by `i-xxxx` id across every epic and the Inbox. */
export function findIssueById(
  board: BoardInfo | undefined,
  issueId: string,
): BoardIssue | undefined {
  if (!board) return undefined;
  for (const epic of board.epics) {
    const hit = epic.issues.find((i) => i.id === issueId);
    if (hit) return hit;
  }
  return board.inbox.find((i) => i.id === issueId);
}

/**
 * Promote a BOARD.md issue into a dispatcher task. Reads the (canonical) board,
 * locates the issue, creates a `delegated-todo` task tagged with board
 * provenance, then best-effort flips the issue to `doing`. A missing issue
 * throws `BoardWriteError NOT_FOUND` (and creates no task); a write race on the
 * status flip is swallowed (the task is already created).
 */
export async function promoteBoardIssueToTask(
  input: PromoteBoardIssueInput,
): Promise<PromoteBoardIssueResult> {
  const dir = await canonicalProjectDir(input.projectPath);
  const board = await scanBoardMd(dir);
  const issue = findIssueById(board, input.issueId);
  if (!issue) {
    throw new BoardWriteError(`Issue ${input.issueId} not found`, "NOT_FOUND");
  }

  const meta: BoardTaskMeta = {
    sourceType: "board-issue",
    boardIssueId: input.issueId,
    projectPath: dir,
    projectSlug: path.basename(dir),
    sessionId: input.sessionId,
    worktree: issue.worktree,
  };

  const task = await createTask({
    title: issue.title.slice(0, 120),
    description: issue.detail ?? issue.title,
    quadrant: "delegated-todo",
    priority: input.priority,
    assigned_skill: input.assignedSkill,
    model: input.model,
    risk_level: input.riskLevel,
    metadata: meta,
  });

  // Best-effort: reflect that the issue is now in flight.
  let updated = board;
  try {
    updated = await setIssueStatus(dir, input.issueId, "doing");
  } catch {
    /* issue raced away / edited — the task is still created */
  }

  return { taskId: task.id, board: updated };
}

/** Parse a task's metadata as board provenance, or null if it isn't board-sourced. */
function parseBoardMeta(task: Task): BoardTaskMeta | null {
  if (!task.metadata) return null;
  try {
    const m = JSON.parse(task.metadata) as BoardTaskMeta;
    if (m.sourceType === "board-issue" && m.boardIssueId && m.projectPath) {
      return m;
    }
  } catch {
    // malformed metadata — ignore
  }
  return null;
}

/**
 * Called when a task completes. If the task was promoted from a board issue,
 * flip that issue to `done`. Best-effort — a missing/edited issue is swallowed
 * so a stale board never fails the task. Sibling to `onTaskCompleteToggleTodo`
 * (the dispatcher calls both); the TODO toggle no-ops on board tasks because
 * their metadata carries no `TODO.md` `sourceFile`/`lineNumber`.
 */
export async function onTaskCompleteSyncBoard(task: Task): Promise<void> {
  const meta = parseBoardMeta(task);
  if (!meta || task.status !== "done") return;

  try {
    await setIssueStatus(meta.projectPath, meta.boardIssueId, "done");
  } catch (err) {
    console.warn(
      `[boardDelegation] Failed to sync board issue ${meta.boardIssueId} ` +
        `to done for task ${task.id} (${meta.projectPath}/BOARD.md):`,
      err,
    );
  }
}
