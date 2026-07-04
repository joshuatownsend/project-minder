// ── Board (BOARD.md — epics → issues) ──────────────────────────────────────
// Roadmap §6.4 hierarchical model. Parsed by src/lib/scanner/boardMd.ts and
// carried on ProjectData.board. Stable IDs (^e-/^i-) are random base36
// surrogate keys assigned by the writer, NOT content hashes — they must survive
// title edits and reorders so the index keys the same item across mutations.
export type BoardStatus =
  | "backlog"
  | "todo"
  | "doing"
  | "review"
  | "done"
  | "triage";
export type BoardPriority = "high" | "med" | "low";

export interface BoardIssue {
  id: string;                 // "i-xxxx" ("" until the writer backfills it)
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  epicId?: string;            // undefined for Inbox items
  worktree?: string;          // @wt:<branch> provenance
  sessionId?: string;         // ~session:<id> provenance
  detail?: string;            // indented detail lines, newline-joined
  line: number;               // 1-based source line, for write-back
  order: number;              // 0-based position within its container
}

export interface BoardEpic {
  id: string;                 // "e-xxxx" ("" until the writer backfills it)
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  description?: string;       // leading `>` blockquote, newline-joined
  line: number;
  order: number;
  issues: BoardIssue[];
}

export interface BoardInfo {
  epics: BoardEpic[];
  inbox: BoardIssue[];        // items under `## Inbox`
  total: number;              // epics + all epic issues + inbox issues
}
