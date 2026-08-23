import { looksLikeSessionId } from "@/lib/sessionId";

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
 *
 * Derived on demand rather than stored on the session row. A stored column
 * would be written by the same parse that stamps `derived_version`, so a
 * not-yet-re-derived child would have no link — and a roll-up looking for
 * children by that column would find none and report the root's own counts as a
 * complete tree. The failure is specifically invisible: the sessions whose link
 * is missing are exactly the stale ones the version gate exists to catch
 * (Codex review of #428). `file_path` is on every row at every version, so
 * deriving from it cannot hide a child.
 */

/**
 * The parent session id for a subagent transcript, or `undefined` for an
 * ordinary top-level transcript.
 *
 * Accepts either path separator: the paths come from `fs.readdir` on Windows and
 * from fixtures on CI, and a rule that only understood one would return
 * `undefined` on the other — which reads as "this is a root session" rather
 * than as a parse failure.
 *
 * The id check is `looksLikeSessionId` — the NARROW shape predicate, not the
 * permissive `isValidSessionId` traversal guard. It was the latter until #483
 * split the two: that guard now admits anything path-safe, which would let a
 * stray `subagents/` directory anywhere in a tree fabricate a parent id out of
 * its folder's name (`/home/j/notes/inbox/subagents/…` → `"inbox"`). The test
 * for that case is what caught it.
 *
 * The errors are asymmetric, and the asymmetry now points the other way from
 * the #428 note this replaces: rejecting a real session id silently drops a
 * branch of the tree, while accepting a directory that is not one fabricates a
 * link. Position does most of the work regardless — the segment must sit
 * directly above a `subagents` directory.
 */
export function parseSubagentParentSessionId(filePath: string): string | undefined {
  const segments = filePath.split(/[\\/]/);
  // …/<parent>/subagents/<file>
  const fileIdx = segments.length - 1;
  if (fileIdx < 2) return undefined;
  if (segments[fileIdx - 1] !== "subagents") return undefined;
  const parent = segments[fileIdx - 2];
  // `looksLikeSessionId`, NOT `isValidSessionId` (#483). This is the third
  // question the old shared regex was answering: not "is this safe in a path"
  // and not "id or slug", but "does this segment PLAUSIBLY name a session" —
  // a heuristic that stops a stray `subagents/` directory anywhere in a tree
  // from fabricating a parent id out of its parent folder's name. The
  // traversal guard is deliberately permissive now, so it would accept
  // `inbox` here; the narrow shape predicate is the one that means what this
  // line needs. Pinned by `subagentTranscriptPath.test.ts`, which caught this
  // when the guard was widened.
  if (!parent || !looksLikeSessionId(parent)) return undefined;
  return parent;
}
