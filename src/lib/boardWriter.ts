import { promises as fs } from "fs";
import path from "path";
import {
  BoardInfo,
  BoardIssue,
  BoardStatus,
  BoardPriority,
} from "./types";
import { parseBoardMd } from "./scanner/boardMd";
import { scanTodoMd } from "./scanner/todoMd";
import { setTodoCheckedInFile } from "./todoWriter";
import { canonicalProjectDir } from "./canonicalProjectPath";
import { writeFileAtomic, withFileLock } from "./atomicWrite";

// ── Serializing BOARD.md writer ────────────────────────────────────────────
//
// Every mutation: canonical-path-resolved → file-locked → atomic-written →
// re-parsed (so the returned BoardInfo matches disk). The pure `applyXxx`
// transforms below take content → content (and run ID backfill), so they are
// fully unit-testable without fs; the exported async methods wrap them with the
// read/lock/write/re-parse plumbing.
//
// Edits are line-targeted: the writer locates the exact source line via the
// stable ^e-/^i- ref the parser recorded, and rewrites (or splices) only that
// line, preserving all other hand formatting.

const SKELETON = "# Board\n\n<!-- minder-board: v1 -->\n";

export class BoardWriteError extends Error {
  constructor(
    message: string,
    public code: "EMPTY_TITLE" | "NOT_FOUND" | "BAD_TARGET" | "BAD_VALUE",
  ) {
    super(message);
    this.name = "BoardWriteError";
  }
}

// ── Line classifiers (shared with the parser's grammar) ────────────────────
const HEADER_RE = /^##\s/;
const EPIC_HDR_RE = /^##\s+Epic:/i;
const INBOX_HDR_RE = /^##\s+Inbox\b/i;
const ISSUE_LINE_RE = /^\s*-\s*\[[ xX>]\]\s+/;
const DETAIL_RE = /^\s{2,}\S/;
const STATUS_TOKEN_RE = /\[(backlog|todo|doing|review|done|triage)\]/;

/** Checkbox glyph for a status — keeps the markdown readable as a checklist. */
const STATUS_GLYPH: Record<BoardStatus, string> = {
  backlog: " ",
  todo: " ",
  doing: ">",
  review: ">",
  done: "x",
  triage: " ",
};

// Enum guards — derived from STATUS_GLYPH so the valid set has one source of
// truth. A status/priority outside the supported enum would serialize a glyph
// or token the parser can't read back (e.g. `- [undefined] … [blocked]`), so we
// reject it at the writer's entry points rather than corrupting BOARD.md.
const VALID_STATUSES = Object.keys(STATUS_GLYPH) as BoardStatus[];
const VALID_PRIORITIES: readonly BoardPriority[] = ["high", "med", "low"];

function assertStatus(s: BoardStatus | undefined): void {
  if (s !== undefined && !VALID_STATUSES.includes(s)) {
    throw new BoardWriteError(`Invalid status: ${s}`, "BAD_VALUE");
  }
}

function assertPriority(p: BoardPriority | undefined): void {
  if (p !== undefined && !VALID_PRIORITIES.includes(p)) {
    throw new BoardWriteError(`Invalid priority: ${p}`, "BAD_VALUE");
  }
}

// ── ID generation + backfill (P2: random base36 surrogate keys) ────────────

/** Random short surrogate key — STABLE across edits. Never a content hash. */
export function genBoardId(kind: "e" | "i", existing: Set<string>): string {
  let id: string;
  do {
    const rand = Math.random().toString(36).slice(2).padEnd(4, "0").slice(0, 4);
    id = `${kind}-${rand}`;
  } while (existing.has(id));
  existing.add(id);
  return id;
}

/** Every ^e-/^i- id already present, so generation avoids collisions. */
export function collectIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const m of content.matchAll(/\^([ei]-[A-Za-z0-9]+)/g)) ids.add(m[1]);
  return ids;
}

/**
 * Insert a `^e-`/`^i-` ref on any epic/issue line that lacks one. New refs go
 * just before the `[status]` token (or at end of line if none), so they sit
 * with the rest of the metadata.
 */
export function backfillIds(content: string): {
  content: string;
  changed: boolean;
} {
  const ids = collectIds(content);
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isEpic = EPIC_HDR_RE.test(line);
    const isIssue = ISSUE_LINE_RE.test(line);
    if ((isEpic || isIssue) && !/\^[ei]-/.test(line)) {
      const id = genBoardId(isEpic ? "e" : "i", ids);
      const statusIdx = line.search(STATUS_TOKEN_RE);
      if (statusIdx !== -1) {
        lines[i] =
          `${line.slice(0, statusIdx).trimEnd()}  ^${id}  ` +
          line.slice(statusIdx).trimStart();
      } else {
        lines[i] = `${line.trimEnd()}  ^${id}`;
      }
      changed = true;
    }
  }
  return { content: changed ? lines.join(eol) : content, changed };
}

// ── Line formatting ────────────────────────────────────────────────────────

function sanitizeTitle(s: string): string {
  const t = s.replace(/[\r\n\t]+/g, " ").trim();
  if (!t) throw new BoardWriteError("Title is empty", "EMPTY_TITLE");
  return t;
}

/**
 * Normalize a label to the parser's `#([A-Za-z0-9][\w-]*)` grammar so it
 * round-trips losslessly. Without this, a label like "needs review" serializes
 * as `#needs review` and reparses as just `needs` (with "review" bleeding into
 * the title). Characters outside [A-Za-z0-9_-] collapse to a hyphen; the first
 * character must be alphanumeric. "needs review" → "needs-review".
 */
function slugLabel(raw: string): string {
  return raw
    .replace(/^#+/, "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");
}

function cleanLabels(labels: string[] | undefined): string[] {
  return (labels ?? []).map(slugLabel).filter(Boolean);
}

interface IssueLineFields {
  id?: string;
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels?: string[];
  worktree?: string;
  sessionId?: string;
}

/** Render an issue line. ID omitted when empty — backfill assigns it on write. */
function formatIssueLine(f: IssueLineFields): string {
  const parts = [`- [${STATUS_GLYPH[f.status]}] ${f.title}`];
  if (f.id) parts.push(`^${f.id}`);
  parts.push(`[${f.status}]`);
  if (f.priority) parts.push(`!${f.priority}`);
  for (const l of cleanLabels(f.labels)) parts.push(`#${l}`);
  if (f.worktree) parts.push(`@wt:${f.worktree}`);
  if (f.sessionId) parts.push(`~session:${f.sessionId}`);
  return parts.join("  ");
}

function formatEpicHeader(f: {
  id?: string;
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels?: string[];
}): string {
  const parts = [`## Epic: ${f.title}`];
  if (f.id) parts.push(`^${f.id}`);
  parts.push(`[${f.status}]`);
  if (f.priority) parts.push(`!${f.priority}`);
  for (const l of cleanLabels(f.labels)) parts.push(`@${l}`);
  return parts.join("  ");
}

// ── Locators ─────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dominant end-of-line of `content`, so writes preserve CRLF vs LF. */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Index of the *issue row* carrying this `^i-` ref, or -1. Restricted to issue
 * rows (ISSUE_LINE_RE) so a ref mentioned in a detail line, epic description,
 * or comment is never mistaken for the issue itself and mutated/removed.
 */
function findIssueLine(lines: string[], id: string): number {
  const re = new RegExp("\\^" + escapeRegExp(id) + "(?![A-Za-z0-9])");
  return lines.findIndex((l) => ISSUE_LINE_RE.test(l) && re.test(l));
}

function findEpicHeaderLine(lines: string[], epicId: string): number {
  const re = new RegExp("\\^" + escapeRegExp(epicId) + "(?![A-Za-z0-9])");
  return lines.findIndex((l) => EPIC_HDR_RE.test(l) && re.test(l));
}

/** First index at/after `start` that begins a new `## ` section, else length. */
function blockEnd(lines: string[], start: number): number {
  let j = start + 1;
  while (j < lines.length && !HEADER_RE.test(lines[j])) j++;
  return j;
}

/** Exclusive end of an issue's span (its line + contiguous detail lines). */
function issueSpanEnd(lines: string[], p: number): number {
  let j = p + 1;
  while (
    j < lines.length &&
    DETAIL_RE.test(lines[j]) &&
    !ISSUE_LINE_RE.test(lines[j])
  )
    j++;
  return j;
}

/** Where to insert a new issue within a container (after its last issue). */
function containerInsertIndex(lines: string[], headerIdx: number): number {
  const end = blockEnd(lines, headerIdx);
  let insertAt = -1;
  for (let i = headerIdx + 1; i < end; i++) {
    if (ISSUE_LINE_RE.test(lines[i])) {
      insertAt = issueSpanEnd(lines, i);
      i = insertAt - 1;
    }
  }
  if (insertAt === -1) {
    // No issues yet — insert after the header, its blockquote, and any comment.
    let i = headerIdx + 1;
    while (i < end && (/^\s*>/.test(lines[i]) || /^\s*<!--/.test(lines[i]))) i++;
    insertAt = i;
  }
  return insertAt;
}

function findIssue(
  model: BoardInfo | undefined,
  id: string,
): BoardIssue | undefined {
  if (!model) return undefined;
  for (const e of model.epics) {
    const hit = e.issues.find((i) => i.id === id);
    if (hit) return hit;
  }
  return model.inbox.find((i) => i.id === id);
}

// ── Pure transforms (content → content, ID-backfilled) ─────────────────────

export interface NewIssue {
  title: string;
  epicId?: string; // omit ⇒ Inbox
  status?: BoardStatus; // default "todo"
  priority?: BoardPriority;
  labels?: string[];
  worktree?: string; // @wt:
  sessionId?: string; // ~session:
}

export function applyAddIssue(content: string, issue: NewIssue): string {
  const title = sanitizeTitle(issue.title);
  const line = formatIssueLine({
    title,
    status: issue.status ?? "todo",
    priority: issue.priority,
    labels: issue.labels,
    worktree: issue.worktree,
    sessionId: issue.sessionId,
  });
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);

  let headerIdx: number;
  if (issue.epicId) {
    headerIdx = findEpicHeaderLine(lines, issue.epicId);
    if (headerIdx === -1)
      throw new BoardWriteError(`Epic ${issue.epicId} not found`, "BAD_TARGET");
  } else {
    headerIdx = lines.findIndex((l) => INBOX_HDR_RE.test(l));
    if (headerIdx === -1) {
      // No Inbox section yet — append one.
      const body = content.replace(/\s*$/, "");
      return backfillIds(`${body}${eol}${eol}## Inbox${eol}${line}${eol}`)
        .content;
    }
  }

  const at = containerInsertIndex(lines, headerIdx);
  lines.splice(at, 0, line);
  return backfillIds(lines.join(eol)).content;
}

export function applyAddEpic(
  content: string,
  title: string,
  opts?: {
    status?: BoardStatus;
    priority?: BoardPriority;
    description?: string;
  },
): string {
  const header = formatEpicHeader({
    title: sanitizeTitle(title),
    status: opts?.status ?? "backlog",
    priority: opts?.priority,
  });
  const epicLines = [header];
  if (opts?.description) {
    for (const dl of opts.description.split(/\r?\n/)) epicLines.push(`> ${dl}`);
  }

  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const inboxIdx = lines.findIndex((l) => INBOX_HDR_RE.test(l));
  if (inboxIdx === -1) {
    const body = content.replace(/\s*$/, "");
    return backfillIds(`${body}${eol}${eol}${epicLines.join(eol)}${eol}`)
      .content;
  }

  // Insert the epic just before the Inbox (Inbox stays last), blank-separated.
  const insert = [...epicLines, ""];
  if (inboxIdx > 0 && lines[inboxIdx - 1].trim() !== "") insert.unshift("");
  lines.splice(inboxIdx, 0, ...insert);
  return backfillIds(lines.join(eol)).content;
}

export function applySetIssueStatus(
  content: string,
  id: string,
  status: BoardStatus,
): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const p = findIssueLine(lines, id);
  if (p === -1)
    throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");
  const issue = findIssue(parseBoardMd(content), id);
  if (!issue) throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");
  const indent = lines[p].match(/^\s*/)![0];
  lines[p] = indent + formatIssueLine({ ...issue, status });
  return backfillIds(lines.join(eol)).content;
}

export function applyEditIssue(
  content: string,
  id: string,
  patch: Partial<Pick<NewIssue, "title" | "priority" | "labels">>,
): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const p = findIssueLine(lines, id);
  if (p === -1)
    throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");
  const issue = findIssue(parseBoardMd(content), id);
  if (!issue) throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");
  const indent = lines[p].match(/^\s*/)![0];
  lines[p] =
    indent +
    formatIssueLine({
      ...issue,
      title: patch.title !== undefined ? sanitizeTitle(patch.title) : issue.title,
      priority: "priority" in patch ? patch.priority : issue.priority,
      labels: patch.labels !== undefined ? patch.labels : issue.labels,
    });
  return backfillIds(lines.join(eol)).content;
}

export function applyMoveIssue(
  content: string,
  id: string,
  toEpicId: string | "inbox",
): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const p = findIssueLine(lines, id);
  if (p === -1)
    throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");
  const end = issueSpanEnd(lines, p);
  const span = lines.slice(p, end);
  lines.splice(p, end - p);

  let headerIdx: number;
  if (toEpicId === "inbox") {
    headerIdx = lines.findIndex((l) => INBOX_HDR_RE.test(l));
    if (headerIdx === -1) {
      const body = lines.join(eol).replace(/\s*$/, "");
      return backfillIds(`${body}${eol}${eol}## Inbox${eol}${span.join(eol)}${eol}`)
        .content;
    }
  } else {
    headerIdx = findEpicHeaderLine(lines, toEpicId);
    if (headerIdx === -1)
      throw new BoardWriteError(`Epic ${toEpicId} not found`, "BAD_TARGET");
  }

  const at = containerInsertIndex(lines, headerIdx);
  lines.splice(at, 0, ...span);
  return backfillIds(lines.join(eol)).content;
}

export function applyReorderIssue(
  content: string,
  id: string,
  newOrder: number,
): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const p = findIssueLine(lines, id);
  if (p === -1)
    throw new BoardWriteError(`Issue ${id} not found`, "NOT_FOUND");

  // Capture the owning header before removal so the container bounds stay
  // correct even when this is the container's only issue.
  let headerIdx = -1;
  for (let i = p; i >= 0; i--) {
    if (HEADER_RE.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  const bodyStart = headerIdx === -1 ? 0 : headerIdx + 1;

  const end = issueSpanEnd(lines, p);
  const span = lines.slice(p, end);
  lines.splice(p, end - p);

  // Body end on the reduced array, derived from the captured header.
  let bodyEnd: number;
  if (headerIdx === -1) {
    bodyEnd = 0;
    while (bodyEnd < lines.length && !HEADER_RE.test(lines[bodyEnd])) bodyEnd++;
  } else {
    bodyEnd = blockEnd(lines, headerIdx);
  }

  // Primary-line index of each remaining sibling issue.
  const issueIdxs: number[] = [];
  for (let i = bodyStart; i < bodyEnd; i++) {
    if (ISSUE_LINE_RE.test(lines[i])) {
      issueIdxs.push(i);
      i = issueSpanEnd(lines, i) - 1;
    }
  }

  const k = Math.max(0, Math.min(newOrder, issueIdxs.length));
  const at = k < issueIdxs.length ? issueIdxs[k] : bodyEnd;
  lines.splice(at, 0, ...span);
  return backfillIds(lines.join(eol)).content;
}

// ── Async public API (canonical-resolved, locked, atomic, re-parsed) ───────

async function mutate(
  projectPath: string,
  transform: (content: string) => string,
): Promise<BoardInfo | undefined> {
  const dir = await canonicalProjectDir(projectPath);
  const filePath = path.join(dir, "BOARD.md");
  return withFileLock(filePath, async () => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") content = SKELETON;
      else throw err;
    }
    const next = transform(content);
    if (next !== content) await writeFileAtomic(filePath, next);
    return parseBoardMd(next);
  });
}

export async function addIssue(
  projectPath: string,
  issue: NewIssue,
): Promise<BoardInfo | undefined> {
  assertStatus(issue.status);
  assertPriority(issue.priority);
  return mutate(projectPath, (c) => applyAddIssue(c, issue));
}

export async function addEpic(
  projectPath: string,
  title: string,
  opts?: { status?: BoardStatus; priority?: BoardPriority; description?: string },
): Promise<BoardInfo | undefined> {
  assertStatus(opts?.status);
  assertPriority(opts?.priority);
  return mutate(projectPath, (c) => applyAddEpic(c, title, opts));
}

export async function setIssueStatus(
  projectPath: string,
  id: string,
  status: BoardStatus,
): Promise<BoardInfo | undefined> {
  assertStatus(status);
  return mutate(projectPath, (c) => applySetIssueStatus(c, id, status));
}

export async function editIssue(
  projectPath: string,
  id: string,
  patch: Partial<Pick<NewIssue, "title" | "priority" | "labels">>,
): Promise<BoardInfo | undefined> {
  assertPriority(patch.priority);
  return mutate(projectPath, (c) => applyEditIssue(c, id, patch));
}

export function moveIssue(
  projectPath: string,
  id: string,
  toEpicId: string | "inbox",
): Promise<BoardInfo | undefined> {
  return mutate(projectPath, (c) => applyMoveIssue(c, id, toEpicId));
}

export function reorderIssue(
  projectPath: string,
  id: string,
  newOrder: number,
): Promise<BoardInfo | undefined> {
  return mutate(projectPath, (c) => applyReorderIssue(c, id, newOrder));
}

// ── TODO → board promote path (§6.1) ───────────────────────────────────────

export interface PromoteTodoInput {
  projectPath: string;
  /** 1-based line number of the `- [ ]` item in the project's TODO.md. */
  lineNumber: number;
  /** Target epic; omit ⇒ the issue lands in the Inbox. */
  epicId?: string;
  status?: BoardStatus;
  priority?: BoardPriority;
  labels?: string[];
  /** Tick the source TODO off once promoted (default true). */
  checkOff?: boolean;
}

/**
 * Promote a TODO.md line into a board issue. Reads the todo's text by line
 * number from the *canonical* TODO.md, creates a board issue from it, then (by
 * default) checks the TODO off. Board and TODO writes take separate file locks
 * — distinct files, so no deadlock. Canonicalizing the dir once up front means
 * the line we read and the line we tick are guaranteed to be the same file.
 */
export async function promoteTodoToBoard(
  input: PromoteTodoInput,
): Promise<BoardInfo | undefined> {
  const dir = await canonicalProjectDir(input.projectPath);
  const todos = await scanTodoMd(dir);
  const item = todos?.items.find((t) => t.lineNumber === input.lineNumber);
  if (!item) {
    throw new BoardWriteError(
      `No TODO item at line ${input.lineNumber}`,
      "NOT_FOUND",
    );
  }

  const board = await addIssue(dir, {
    title: item.text,
    epicId: input.epicId,
    status: input.status,
    priority: input.priority,
    labels: input.labels,
  });

  // Idempotently mark the source todo done (set, not toggle) so two overlapping
  // promotes can't flip it back open — a no-op when it's already checked.
  if (input.checkOff !== false) {
    await setTodoCheckedInFile(dir, input.lineNumber, true);
  }

  return board;
}
