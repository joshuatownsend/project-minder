import type { UsageTurn } from "./types";
import { FILE_OP_BY_TOOL, isFileWriteOp, type FileOp } from "./toolNames";

export interface FileEdit {
  sessionId: string;
  turnIndex: number;
  filePath: string;
  op: FileOp;
  timestamp: string;
}

/**
 * Extract all file-touching tool calls from assistant turns.
 * Mirrors `extractFileOp()` in `src/lib/db/ingest.ts` exactly:
 * only `args.file_path` is consulted (not `args.path` or `args.notebook_path`).
 * NotebookEdit uses the same `file_path` key as source-file tools.
 */
export function extractFileEdits(turns: UsageTurn[]): FileEdit[] {
  const edits: FileEdit[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    for (const tc of turn.toolCalls) {
      const op = FILE_OP_BY_TOOL[tc.name];
      if (!op) continue;
      const filePath =
        typeof tc.arguments?.file_path === "string" ? tc.arguments.file_path : null;
      if (!filePath) continue;
      edits.push({ sessionId: turn.sessionId, turnIndex: i, filePath, op, timestamp: turn.timestamp });
    }
  }
  return edits;
}

/** Write-class subset (write / edit / delete) — excludes Read ops. */
export function extractWriteEdits(turns: UsageTurn[]): FileEdit[] {
  return extractFileEdits(turns).filter((e) => isFileWriteOp(e.op));
}
