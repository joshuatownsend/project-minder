/**
 * Parent-session linkage for subagent transcripts, derived from the file path.
 *
 * Newer Claude Code writes a delegated agent's turns to its own file at
 * `<project>/<parent-session-id>/subagents/agent-<id>.jsonl` instead of inlining
 * them into the parent transcript. Minder ingests each of those as a **separate
 * session** — they share no `session_id` with the session that spawned them, and
 * `turns.parent_tool_use_id` is NULL on every row of the reference index — so
 * the directory name is the only linkage that actually exists in this data.
 *
 * Measured on the local corpus (2026-08-11): 1,260 subagent transcripts, all
 * resolving to a parent id by this rule, and 126/126 of those parents present in
 * the index. The layout is **flat** — a subagent that itself delegates writes
 * into the same `<root>/subagents/` directory rather than nesting under its own
 * spawner — so one level of linkage covers the whole tree. That is what makes a
 * tree roll-up possible at all; `depth` still is not recoverable, because
 * flatness is exactly the property that discards it.
 */

/** A Claude Code session id: a UUID, or the hex-ish ids used by test fixtures. */
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{5,}$/;

/**
 * The parent session id for a subagent transcript, or `undefined` for an
 * ordinary top-level transcript.
 *
 * Accepts either path separator: the paths come from `fs.readdir` on Windows and
 * from fixtures on CI, and a rule that only understood one separator would
 * return `undefined` on the other — which reads as "this is a root session"
 * rather than as a parse failure.
 */
export function parseSubagentParentSessionId(filePath: string): string | undefined {
  const segments = filePath.split(/[\\/]/);
  // …/<parent>/subagents/<file>
  const fileIdx = segments.length - 1;
  if (fileIdx < 2) return undefined;
  if (segments[fileIdx - 1] !== "subagents") return undefined;
  const parent = segments[fileIdx - 2];
  if (!parent || !SESSION_ID_RE.test(parent)) return undefined;
  return parent;
}
