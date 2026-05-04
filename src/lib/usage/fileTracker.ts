import type { UsageTurn } from "./types";
import { extractWriteEdits } from "./fileActivity";

export interface HotFile {
  readonly filePath: string;
  readonly editCount: number;
  readonly sessionCount: number;
  readonly lastEditTs: string;
  readonly ops: Readonly<{ write: number; edit: number; delete: number }>;
}

export interface HotFilesResult {
  readonly hotFiles: readonly HotFile[];
  readonly totalFiles: number;
  /** Total write-class edits across all files (not just the top-N slice). */
  readonly totalEdits: number;
}

export function buildHotFiles(turns: UsageTurn[], limit = 50): HotFilesResult {
  const edits = extractWriteEdits(turns);

  const fileMap = new Map<
    string,
    { editCount: number; sessions: Set<string>; lastEditTs: string; ops: { write: number; edit: number; delete: number } }
  >();

  for (const edit of edits) {
    let entry = fileMap.get(edit.filePath);
    if (!entry) {
      entry = { editCount: 0, sessions: new Set(), lastEditTs: edit.timestamp, ops: { write: 0, edit: 0, delete: 0 } };
      fileMap.set(edit.filePath, entry);
    }
    entry.editCount++;
    entry.sessions.add(edit.sessionId);
    if (edit.timestamp > entry.lastEditTs) entry.lastEditTs = edit.timestamp;
    if (edit.op === "write") entry.ops.write++;
    else if (edit.op === "edit") entry.ops.edit++;
    else if (edit.op === "delete") entry.ops.delete++;
  }

  const hotFiles = [...fileMap.entries()]
    .sort(
      (a, b) =>
        b[1].editCount - a[1].editCount ||
        // ISO-8601 strings are lexicographically chronological, so localeCompare is a valid recency tiebreaker.
        b[1].lastEditTs.localeCompare(a[1].lastEditTs)
    )
    .slice(0, limit)
    .map(([filePath, d]) => ({
      filePath,
      editCount: d.editCount,
      sessionCount: d.sessions.size,
      lastEditTs: d.lastEditTs,
      ops: d.ops,
    }));

  return { hotFiles, totalFiles: fileMap.size, totalEdits: edits.length };
}
