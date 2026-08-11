/**
 * #395 — the only parent→child linkage this data has.
 *
 * Subagent transcripts ingest as their own sessions and `parent_tool_use_id` is
 * NULL on every indexed row, so the directory name is the whole of the
 * relationship. A miss here does not surface as an error: it reads as "this is
 * an ordinary top-level session", and the roll-up quietly loses a branch.
 */
import { describe, it, expect } from "vitest";
import { parseSubagentParentSessionId } from "@/lib/sessions/subagentTranscriptPath";

const PARENT = "44d8e9d9-d568-4453-9d28-41d91577d91b";

describe("parseSubagentParentSessionId", () => {
  it("reads the parent id from a Windows subagent path", () => {
    expect(
      parseSubagentParentSessionId(
        `C:\\Users\\joshu\\.claude\\projects\\C--dev-PAL-X\\${PARENT}\\subagents\\agent-a0f65d20fc00c2954.jsonl`
      )
    ).toBe(PARENT);
  });

  it("reads the parent id from a POSIX subagent path", () => {
    // Both separators matter: these paths come from `fs.readdir` on Windows and
    // from fixtures on CI. A rule that understood only one would return
    // undefined on the other — which reads as "root session", not as a failure.
    expect(
      parseSubagentParentSessionId(
        `/home/j/.claude/projects/-dev-pal/${PARENT}/subagents/agent-1.jsonl`
      )
    ).toBe(PARENT);
  });

  it("returns undefined for an ordinary top-level transcript", () => {
    expect(
      parseSubagentParentSessionId(`C:\\Users\\joshu\\.claude\\projects\\C--dev-PAL-X\\${PARENT}.jsonl`)
    ).toBeUndefined();
  });

  it("returns undefined when the directory above is not `subagents`", () => {
    // A project directory that happens to sit two levels up must not be read as
    // a parent session id.
    expect(
      parseSubagentParentSessionId(`/home/j/.claude/projects/${PARENT}/other/agent-1.jsonl`)
    ).toBeUndefined();
  });

  it("returns undefined when the parent segment is not a session id", () => {
    // Guards against a stray `subagents/` directory anywhere else in a tree
    // turning its parent folder's name into a fabricated session id.
    expect(
      parseSubagentParentSessionId("/home/j/notes/inbox/subagents/agent-1.jsonl")
    ).toBeUndefined();
  });

  it("returns undefined for a path with nothing above the file", () => {
    expect(parseSubagentParentSessionId("agent-1.jsonl")).toBeUndefined();
  });
});
