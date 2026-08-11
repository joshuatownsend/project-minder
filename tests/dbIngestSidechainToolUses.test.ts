/**
 * #395 — subagent tool calls reaching the index, and the roll-up over them.
 *
 * Before this, a subagent's tool calls were stored nowhere. `tool_uses` holds
 * primary turns only, so the delegation-cap comparison on /sessions asked a
 * table that structurally could not answer and read the resulting zero as "no
 * nested work" — the badge stayed silent in exactly the runaway case it exists
 * to warn about.
 *
 * The fixtures deliberately use the modern transcript layout: a subagent gets
 * its own file under `<parent-session-id>/subagents/`, which ingests as its own
 * session sharing no `session_id` with its parent. That separation is the whole
 * difficulty — the roll-up cannot be a per-session query.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { parseSubagentParentSessionId } from "@/lib/sessions/subagentTranscriptPath";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

// Pinned for the same reason as `dbIngestMessageContinuation.test.ts`: these
// assertions read indexed rows, so the DB backend is a requirement of the file
// rather than an ambient preference.
const state = installIsolatedState({
  prefix: "pm-ingest-sidechain-",
  env: { MINDER_USE_DB: "1" },
});
let tmpHome: string;

async function reload() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  return { conn, mig, ingest };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const toolBlock = (id: string, name: string) => ({
  type: "tool_use",
  id,
  name,
  input: { q: name },
});

/** One JSONL line carrying one content block, as Claude Code emits them. */
function assistantLine(
  timestamp: string,
  messageId: string,
  block: unknown,
  isSidechain: boolean
) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    isSidechain,
    message: {
      id: messageId,
      model: "claude-sonnet-4-5",
      content: [block],
      stop_reason: "tool_use",
      usage: USAGE,
    },
  });
}

const userLine = (timestamp: string, text: string, isSidechain = false) =>
  JSON.stringify({
    type: "user",
    timestamp,
    isSidechain,
    message: { content: [{ type: "text", text }] },
  });

/** A root transcript that spawns one agent and runs one search itself. */
async function writeRoot(projectsDir: string, sessionId: string): Promise<string> {
  const file = path.join(projectsDir, "C--dev-myapp", `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      userLine("2026-08-01T10:00:00Z", "sweep the codebase"),
      assistantLine("2026-08-01T10:00:01Z", "m1", toolBlock("r_a", "Agent"), false),
      assistantLine("2026-08-01T10:00:01Z", "m1", toolBlock("r_w", "WebSearch"), false),
    ].join("\n") + "\n"
  );
  return file;
}

/**
 * A subagent transcript for `parentId`. Every line is sidechain, which is what
 * these files actually look like: 110,622 sidechain lines against 34
 * non-sidechain across the 1,260 local transcripts.
 */
async function writeSubagent(
  projectsDir: string,
  parentId: string,
  agentFile: string,
  blocks: Array<{ id: string; name: string }>
): Promise<string> {
  const file = path.join(
    projectsDir,
    "C--dev-myapp",
    parentId,
    "subagents",
    `${agentFile}.jsonl`
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [userLine("2026-08-01T10:00:02Z", "scan for X", true)];
  blocks.forEach((b, i) => {
    lines.push(
      assistantLine(`2026-08-01T10:00:0${3 + i}Z`, `s${i}`, toolBlock(b.id, b.name), true)
    );
  });
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("#395 subagent tool calls", () => {
  async function ingestAll() {
    const { conn, mig, ingest } = await reload();
    const init = await mig.initDb();
    expect(init.error).toBeNull();
    const db = (await conn.getDb())!;
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    return { db, projectsDir, ingest };
  }

  it("records tool calls made inside subagent turns", async () => {
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe11");
    await writeSubagent(projectsDir, "cafe11", "agent-1", [
      { id: "s_a", name: "Agent" },
      { id: "s_w1", name: "WebSearch" },
      { id: "s_w2", name: "WebSearch" },
    ]);
    const stats = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);

    const counts = db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id <> 'cafe11' GROUP BY tool_name ORDER BY tool_name`
      )
      .all() as Array<{ tool_name: string; n: number }>;
    expect(counts.map((c) => [c.tool_name, c.n])).toEqual([
      ["Agent", 1],
      ["WebSearch", 2],
    ]);

    // The counterpart assertion, and the reason a separate table exists: the
    // subagent's calls must NOT appear in `tool_uses`, which ~20 queries read
    // with no sidechain predicate.
    const toolUses = db
      .prepare(`SELECT COUNT(*) AS n FROM tool_uses WHERE session_id <> 'cafe11'`)
      .get() as { n: number };
    expect(toolUses.n).toBe(0);
  });

  it("leaves the parent session's own tool counts untouched", async () => {
    // #395's explicit constraint: /costs, /stats and the per-session views are
    // built on "calls made by the root turn set", and this change must not move
    // any of them.
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe12");
    await writeSubagent(projectsDir, "cafe12", "agent-1", [
      { id: "s_a", name: "Agent" },
      { id: "s_b", name: "Agent" },
    ]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    const rootTools = db
      .prepare(
        "SELECT tool_name, COUNT(*) AS n FROM tool_uses WHERE session_id = 'cafe12' GROUP BY tool_name ORDER BY tool_name"
      )
      .all() as Array<{ tool_name: string; n: number }>;
    expect(rootTools.map((t) => [t.tool_name, t.n])).toEqual([
      ["Agent", 1],
      ["WebSearch", 1],
    ]);
    // And the root records no sidechain calls of its own under this layout.
    const rootSidechain = db
      .prepare("SELECT COUNT(*) AS n FROM sidechain_tool_uses WHERE session_id = 'cafe12'")
      .get() as { n: number };
    expect(rootSidechain.n).toBe(0);
  });

  it("dedupes a tool block re-logged on a continuation line", async () => {
    // #426 in miniature. One line per content block means a repeated block
    // arrives as another line sharing the message id; counting blocks instead of
    // `tool_use_id`s inflated the local corpus by 83 calls.
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe13");
    const file = path.join(
      projectsDir,
      "C--dev-myapp",
      "cafe13",
      "subagents",
      "agent-1.jsonl"
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        userLine("2026-08-01T10:00:02Z", "scan", true),
        assistantLine("2026-08-01T10:00:03Z", "s0", toolBlock("dup", "WebSearch"), true),
        // Same message, same tool_use_id, emitted again.
        assistantLine("2026-08-01T10:00:03Z", "s0", toolBlock("dup", "WebSearch"), true),
        // Same tool_use_id under a DIFFERENT message id — still one call.
        assistantLine("2026-08-01T10:00:04Z", "s1", toolBlock("dup", "WebSearch"), true),
        assistantLine("2026-08-01T10:00:05Z", "s2", toolBlock("real", "WebSearch"), true),
      ].join("\n") + "\n"
    );
    await ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id <> 'cafe13' AND tool_name = 'WebSearch'`
      )
      .get() as { n: number };
    expect(row.n).toBe(2);
  });

  it("carries a tail window's calls alongside the ones already recorded", async () => {
    // `appendSessionTail` amends a session in place as its file grows. A
    // replacing write here would report only the final window's calls, so a
    // long-running session's subagent work would SHRINK as it ran.
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe14");
    const file = await writeSubagent(projectsDir, "cafe14", "agent-1", [
      { id: "s_1", name: "WebSearch" },
    ]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    await fs.appendFile(
      file,
      assistantLine("2026-08-01T10:01:00Z", "s9", toolBlock("s_2", "WebSearch"), true) + "\n"
    );
    const second = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(second.errors).toBe(0);

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id <> 'cafe14' AND tool_name = 'WebSearch'`
      )
      .get() as { n: number };
    expect(row.n).toBe(2);
  });

  it("does not double-count a call re-logged across a tail-window boundary", async () => {
    // The write is additive in effect, so it needs a key that survives between
    // parses. Parse-local dedupe state does not: window 2 has never seen
    // window 1's ids, and a re-log is a NEW LINE rather than a re-read one, so
    // a per-tool counter would add it again and stay wrong until the next full
    // re-parse (Codex review of #428).
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe18");
    const file = await writeSubagent(projectsDir, "cafe18", "agent-1", [
      { id: "straddle", name: "WebSearch" },
    ]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    // Same tool_use_id, emitted again after the byte cursor.
    await fs.appendFile(
      file,
      assistantLine("2026-08-01T10:01:00Z", "s9", toolBlock("straddle", "WebSearch"), true) + "\n"
    );
    await ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id <> 'cafe18' AND tool_name = 'WebSearch'`
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("links a subagent transcript to its parent through its stored path", async () => {
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe15");
    await writeSubagent(projectsDir, "cafe15", "agent-1", [{ id: "s_a", name: "Agent" }]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    const rows = db
      .prepare("SELECT session_id, file_path FROM sessions")
      .all() as Array<{ session_id: string; file_path: string }>;
    const linked = rows.map((r) => [r.session_id, parseSubagentParentSessionId(r.file_path)]);
    expect(linked).toContainEqual(["cafe15", undefined]);
    expect(linked.filter(([, parent]) => parent === "cafe15")).toHaveLength(1);
  });

  it("rolls the whole tree into the session summary's treeDelegation", async () => {
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe16");
    await writeSubagent(projectsDir, "cafe16", "agent-1", [
      { id: "a_1", name: "Agent" },
      { id: "a_2", name: "WebSearch" },
    ]);
    await writeSubagent(projectsDir, "cafe16", "agent-2", [
      { id: "b_1", name: "WebSearch" },
      { id: "b_2", name: "WebSearch" },
    ]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    const { loadSessionsListFromDb } = await import("@/lib/data/sessionsListFromDb");
    const sessions = loadSessionsListFromDb(db);
    const root = sessions.find((s) => s.sessionId === "cafe16");
    expect(root).toBeDefined();
    // Root: 1 Agent + 1 WebSearch. Children: 1 Agent + 3 WebSearch.
    expect(root!.treeDelegation).toEqual({ spawns: 2, webSearches: 4, sessionCount: 3 });
    // The existing per-session fields keep their old meaning — this is the
    // "expose a distinct field rather than widen the summary" contract.
    expect(root!.subagentCount).toBe(1);
    expect(root!.toolUsage["WebSearch"]).toBe(1);
    // Subagent transcripts are not sessions the user ran; they must not show up
    // as blank zero-turn cards.
    expect(sessions.some((s) => s.sessionId !== "cafe16")).toBe(false);
  });

  it("reports treeDelegation as unmeasured when a child is left stale", async () => {
    // The gate that makes the field trustworthy, in the state an upgrade
    // actually produces: the root has been re-derived and its subagent
    // transcript has not. A stale child records no calls, so without the gate
    // the total would look complete and be short by that whole branch.
    const { db, projectsDir, ingest } = await ingestAll();
    await writeRoot(projectsDir, "cafe17");
    await writeSubagent(projectsDir, "cafe17", "agent-1", [{ id: "a_1", name: "Agent" }]);
    await ingest.reconcileAllSessions(db, { projectsDir });

    const { TREE_DELEGATION_MIN_DERIVED_VERSION } = await import("@/lib/usage/delegationTree");
    db.prepare(
      "UPDATE sessions SET derived_version = ? WHERE session_id <> 'cafe17'"
    ).run(TREE_DELEGATION_MIN_DERIVED_VERSION - 1);
    // And its calls are gone, as they would be on an index written before the
    // table existed — so a roll-up that failed to notice would silently return
    // the root's own 1 spawn as the tree total.
    db.prepare("DELETE FROM sidechain_tool_uses WHERE session_id <> 'cafe17'").run();

    const { loadSessionsListFromDb } = await import("@/lib/data/sessionsListFromDb");
    const root = loadSessionsListFromDb(db).find((s) => s.sessionId === "cafe17");
    expect(root!.treeDelegation).toBeUndefined();
  });
});
