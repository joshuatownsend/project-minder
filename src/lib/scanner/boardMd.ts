import { promises as fs } from "fs";
import path from "path";
import {
  BoardInfo,
  BoardEpic,
  BoardIssue,
  BoardStatus,
  BoardPriority,
} from "../types";

// ── BOARD.md grammar (roadmap §6.2) ────────────────────────────────────────
//
//   # Board — <project>
//   <!-- minder-board: v1 -->
//
//   ## Epic: <title> ^e-<id>  [<status>]  !<priority>  @<tag>…
//   > <optional blockquote description line(s)>
//
//   - [ ] <title> ^i-<id>  [<status>]  !<prio>  #<label>…  @wt:<branch>  ~session:<id>
//     <optional indented detail line(s)>
//   - [>] <doing item> ^i-<id>
//   - [x] <done item>  ^i-<id>
//
//   ## Inbox
//   - [ ] (finding) <title> ^i-<id>  [triage]  @wt:<branch>  ~session:<id>
//
// The parser is deliberately tolerant of hand edits: missing IDs, missing
// status tokens (status then derives from the checkbox glyph), extra
// whitespace, and bare `- [ ] thing` lines all parse.

const ID_RE = /\^([ei])-([A-Za-z0-9]+)/;
const STATUS_RE = /\[(backlog|todo|doing|review|done|triage)\]/;
const PRIORITY_RE = /!(high|med|low)\b/;
const WT_RE = /@wt:(\S+)/;
const SESSION_RE = /~session:(\S+)/;
// Global — used by both parseLabels (matchAll) and cleanTitle (replace).
// matchAll clones the regex internally and .replace resets lastIndex on
// completion, so sharing this instance across the two is safe.
const LABEL_G = /#([A-Za-z0-9][\w-]*)/g;
const EPIC_HEADER_RE = /^##\s+Epic:\s*(.*)$/i;
const INBOX_HEADER_RE = /^##\s+Inbox\b/i;
const ISSUE_RE = /^\s*-\s*\[([ x>])\]\s+(.*)$/i;

function glyphToStatus(glyph: string): BoardStatus {
  if (glyph.toLowerCase() === "x") return "done";
  if (glyph === ">") return "doing";
  return "todo";
}

/** Strip every recognised token from a title fragment, leaving prose. */
function cleanTitle(s: string): string {
  return s
    .replace(ID_RE, "")
    .replace(STATUS_RE, "")
    .replace(PRIORITY_RE, "")
    .replace(WT_RE, "")
    .replace(SESSION_RE, "")
    .replace(LABEL_G, "")
    .replace(/@\S+/g, "") // any remaining @tags (already captured separately)
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseLabels(s: string): string[] {
  return [...s.matchAll(LABEL_G)].map((m) => m[1]);
}

/**
 * Parse BOARD.md content into a hierarchical BoardInfo. Pure (no FS).
 * Returns undefined when the file holds no epics or issues.
 */
export function parseBoardMd(content: string): BoardInfo | undefined {
  const lines = content.split(/\r?\n/);
  const epics: BoardEpic[] = [];
  const inbox: BoardIssue[] = [];

  let currentEpic: BoardEpic | null = null;
  let inInbox = false;
  let lastIssue: BoardIssue | null = null;
  let epicOrder = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Epic header: `## Epic: <title> …`
    const epicM = line.match(EPIC_HEADER_RE);
    if (epicM) {
      inInbox = false;
      lastIssue = null;
      const idM = line.match(ID_RE);
      const statusM = line.match(STATUS_RE);
      const prioM = line.match(PRIORITY_RE);
      // Epic tags are `@foo` that are NOT `@wt:` provenance.
      const tags = (line.match(/@\S+/g) || [])
        .filter((t) => !t.startsWith("@wt:"))
        .map((t) => t.slice(1));
      currentEpic = {
        id: idM && idM[1] === "e" ? `e-${idM[2]}` : "",
        title: cleanTitle(epicM[1]),
        status: (statusM?.[1] as BoardStatus) ?? "backlog",
        priority: prioM?.[1] as BoardPriority | undefined,
        labels: tags,
        line: i + 1,
        order: epicOrder++,
        issues: [],
      };
      epics.push(currentEpic);
      continue;
    }

    // Inbox header: `## Inbox`
    if (INBOX_HEADER_RE.test(line)) {
      inInbox = true;
      currentEpic = null;
      lastIssue = null;
      continue;
    }

    // Epic description blockquote — only the `>` lines directly under the epic
    // header, before its first issue.
    if (currentEpic && !lastIssue && /^\s*>\s?/.test(line)) {
      const text = line.replace(/^\s*>\s?/, "");
      currentEpic.description = currentEpic.description
        ? `${currentEpic.description}\n${text}`
        : text;
      continue;
    }

    // Issue line: `- [ ] …` / `- [>] …` / `- [x] …`
    const issueM = line.match(ISSUE_RE);
    if (issueM) {
      const [, glyph, rest] = issueM;
      const idM = rest.match(ID_RE);
      const statusM = rest.match(STATUS_RE);
      const prioM = rest.match(PRIORITY_RE);
      const wtM = rest.match(WT_RE);
      const sessM = rest.match(SESSION_RE);
      // Issues before any epic/Inbox header fall into the Inbox so nothing is
      // silently dropped.
      const container = inInbox ? inbox : currentEpic?.issues ?? inbox;
      const issue: BoardIssue = {
        id: idM && idM[1] === "i" ? `i-${idM[2]}` : "",
        title: cleanTitle(rest),
        // Explicit [status] token wins; otherwise derive from the glyph.
        status: (statusM?.[1] as BoardStatus) ?? glyphToStatus(glyph),
        priority: prioM?.[1] as BoardPriority | undefined,
        labels: parseLabels(rest),
        // Preserve "" for issues under a not-yet-backfilled epic: epicId is
        // only undefined for genuine Inbox/orphan items, so `epicId !==
        // undefined` reliably means "belongs to an epic" even pre-backfill.
        epicId: inInbox ? undefined : currentEpic ? currentEpic.id : undefined,
        worktree: wtM?.[1],
        sessionId: sessM?.[1],
        line: i + 1,
        order: container.length,
      };
      container.push(issue);
      lastIssue = issue;
      continue;
    }

    // Indented continuation line → detail of the last issue. Uses the raw line
    // so leading indentation is what's tested.
    if (lastIssue && /^\s{2,}\S/.test(raw)) {
      const text = raw.trim();
      lastIssue.detail = lastIssue.detail
        ? `${lastIssue.detail}\n${text}`
        : text;
      continue;
    }

    // A blank line ends detail capture for the current issue (but keeps the
    // epic context, so the next issue still attaches to this epic).
    if (line.trim() === "") lastIssue = null;
  }

  const total =
    epics.length +
    epics.reduce((n, e) => n + e.issues.length, 0) +
    inbox.length;

  if (total === 0) return undefined;
  return { epics, inbox, total };
}

/** Read BOARD.md from a project root. Returns undefined if absent/empty. */
export async function scanBoardMd(
  projectPath: string,
): Promise<BoardInfo | undefined> {
  try {
    // Literal filename in the join (not a parameter) so static analysis sees a
    // fixed path component — mirrors the todoMd / insightsMd scanners.
    const content = await fs.readFile(
      path.join(projectPath, "BOARD.md"),
      "utf-8",
    );
    return parseBoardMd(content);
  } catch {
    return undefined;
  }
}

/**
 * On-demand read of BOARD.archive.md (the done/history lane). The scan
 * orchestrator never reads archive files — same convention as scanTodoArchive —
 * so active board counts stay clean.
 */
export async function scanBoardArchive(
  projectPath: string,
): Promise<BoardInfo | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "BOARD.archive.md"),
      "utf-8",
    );
    return parseBoardMd(content);
  } catch {
    return undefined;
  }
}
