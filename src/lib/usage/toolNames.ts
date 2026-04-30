// Canonical tool-name constants for the SQLite ingest path
// (`src/lib/db/ingest.ts`). Keeps the `Agent` / `Skill` / file-op
// conventions in one place so ingest can't silently drift from real
// JSONL emission. The file-parse modules (`classifier.ts`,
// `agentParser.ts`, `skillParser.ts`) currently hardcode the same
// names — when convenient they should migrate to import from here so
// drift can't happen across paths either.

export type FileOp = "read" | "write" | "edit" | "delete";

/**
 * Tool name → `tool_uses.file_op` mapping when the tool also takes a
 * `file_path` argument. Used by ingest to populate `file_op` and decide
 * whether the `file_edits` projection should get a row.
 *
 * `NotebookEdit` is included as an `edit` op — it carries the same
 * `file_path` argument shape and the file_edits projection should treat
 * notebook edits identically to source edits.
 */
export const FILE_OP_BY_TOOL: Readonly<Record<string, FileOp>> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
};

/** Tools that can launch a subagent. The args carry `subagent_type`. */
export const AGENT_DISPATCH_TOOL = "Agent";

/** Tool that invokes a skill. The args carry `skill`. */
export const SKILL_DISPATCH_TOOL = "Skill";

/** Convenience predicate: does this tool produce a row in `file_edits`? */
export function isFileWriteOp(op: FileOp | null | undefined): boolean {
  return op === "write" || op === "edit" || op === "delete";
}
