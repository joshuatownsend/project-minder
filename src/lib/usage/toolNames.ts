// Canonical tool-name constants used across the file-parse path
// (`classifier.ts`, `agentParser.ts`, `skillParser.ts`) and the SQLite
// ingest path (`db/ingest.ts`). Keeping these in one module prevents
// drift between the two paths — particularly the agent-dispatch tool
// name, which Claude Code's JSONL emits as "Agent" (not "Task" as the
// public Anthropic SDK uses).

export type FileOp = "read" | "write" | "edit" | "delete";

/**
 * Tool name → `tool_uses.file_op` mapping when the tool also takes a
 * `file_path` argument. Used by ingest to populate `file_op` and decide
 * whether the `file_edits` projection should get a row.
 */
export const FILE_OP_BY_TOOL: Readonly<Record<string, FileOp>> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
};

/** Tools that can launch a subagent. The args carry `subagent_type`. */
export const AGENT_DISPATCH_TOOL = "Agent";

/** Tool that invokes a skill. The args carry `skill`. */
export const SKILL_DISPATCH_TOOL = "Skill";

/** Convenience predicate: does this tool produce a row in `file_edits`? */
export function isFileWriteOp(op: FileOp | null | undefined): boolean {
  return op === "write" || op === "edit" || op === "delete";
}
