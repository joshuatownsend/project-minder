import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Ingest integration test. Lives in tmpHome with a synthetic
// `.claude/projects/...` tree so we never touch real user data.
//
// Test shape mirrors `dbMigrations.test.ts` — describe.skipIf when the
// optional better-sqlite3 binary isn't installed; reload modules per
// test so connection.ts's globalThis singleton doesn't leak state.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

interface Reloaded {
  conn: typeof import("@/lib/db/connection");
  mig: typeof import("@/lib/db/migrations");
  ingest: typeof import("@/lib/db/ingest");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function freshTempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-ingest-test-"));
}

async function reloadModulesPointingAt(home: string): Promise<Reloaded> {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  return { conn, mig, ingest };
}

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
  content?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(filePath, content);
}

function userTurn(timestamp: string, text: string): JsonlEntry {
  return {
    type: "user",
    timestamp,
    message: { content: [{ type: "text", text }] },
  };
}

function assistantTurn(
  timestamp: string,
  model: string,
  text: string,
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = [],
  usage: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }> = {}
): JsonlEntry {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return {
    type: "assistant",
    timestamp,
    message: {
      model,
      content,
      usage: {
        input_tokens: usage.input_tokens ?? 100,
        output_tokens: usage.output_tokens ?? 50,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await freshTempHome();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("reconcileAllSessions", () => {
  async function setup(): Promise<{ reloaded: Reloaded; projectsDir: string }> {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();
    expect(init.available).toBe(true);
    return {
      reloaded,
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    };
  }

  it("ingests a single session into sessions/turns/tool_uses/file_edits", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-myapp", "abc-session.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "fix the migration bug"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "Looking at the migration",
        [{ id: "tu_1", name: "Read", input: { file_path: "/repo/migrate.ts" } }],
        { input_tokens: 200, output_tokens: 100 }
      ),
      assistantTurn(
        "2026-04-30T10:00:02Z",
        "claude-sonnet-4-5",
        "Fixing it",
        [
          { id: "tu_2", name: "Edit", input: { file_path: "/repo/migrate.ts", old_string: "x", new_string: "y" } },
          { id: "tu_3", name: "Bash", input: { command: "npm test" } },
        ],
        { input_tokens: 200, output_tokens: 80 }
      ),
    ]);

    const stats = await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    expect(stats.filesSeen).toBe(1);
    expect(stats.filesChanged).toBe(1);
    expect(stats.errors).toBe(0);
    expect(stats.rowsWritten).toBeGreaterThan(0);

    const db = (await reloaded.conn.getDb())!;
    const session = db
      .prepare("SELECT * FROM sessions WHERE session_id = 'abc-session'")
      .get() as any;
    expect(session).toBeDefined();
    expect(session.turn_count).toBe(3);
    expect(session.assistant_turn_count).toBe(2);
    expect(session.user_turn_count).toBe(1);
    expect(session.tool_call_count).toBe(3);
    expect(session.primary_model).toBe("claude-sonnet-4-5");
    expect(session.cost_usd).toBeGreaterThan(0);
    expect(session.initial_prompt).toBe("fix the migration bug");
    expect(session.last_prompt).toBe("fix the migration bug");
    expect(session.derived_version).toBe(3);

    const turnRows = db
      .prepare("SELECT role, category FROM turns WHERE session_id = 'abc-session' ORDER BY turn_index")
      .all() as Array<{ role: string; category: string | null }>;
    expect(turnRows.map((r) => r.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turnRows[0].category).toBeNull(); // user turns get no category
    expect(turnRows[1].category).toBeTypeOf("string");

    const toolRows = db
      .prepare("SELECT tool_name, file_op, file_path FROM tool_uses WHERE session_id = 'abc-session' ORDER BY turn_index, sequence_in_turn")
      .all();
    expect(toolRows).toHaveLength(3);
    expect(toolRows).toContainEqual({ tool_name: "Read", file_op: "read", file_path: "/repo/migrate.ts" });
    expect(toolRows).toContainEqual({ tool_name: "Edit", file_op: "edit", file_path: "/repo/migrate.ts" });

    const fileEditRows = db
      .prepare("SELECT file_path, op FROM file_edits WHERE session_id = 'abc-session'")
      .all();
    // file_edits is write/edit/delete only — the Read above shouldn't be here.
    expect(fileEditRows).toEqual([{ file_path: "/repo/migrate.ts", op: "edit" }]);

    const ftsHits = db
      .prepare("SELECT session_id FROM prompts_fts WHERE prompts_fts MATCH 'migration'")
      .all();
    expect(ftsHits.length).toBeGreaterThan(0);

    reloaded.conn.closeDb();
  });

  it("is idempotent: re-running reconcile with no file changes writes 0 rows", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-x", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "hi"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "hello"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    const first = await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(first.filesChanged).toBe(1);

    const second = await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(second.filesSeen).toBe(1);
    expect(second.filesChanged).toBe(0);
    expect(second.rowsWritten).toBe(0);

    reloaded.conn.closeDb();
  });

  it("re-parses a session when its file mtime changes", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-y", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "first prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "first response"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const beforeCount = (db
      .prepare("SELECT turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { turn_count: number }).turn_count;
    expect(beforeCount).toBe(2);

    // Append turns and bump mtime explicitly (writeFile may resolve to the
    // same mtime when the OS rounds to the second).
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "first prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "first response"),
      userTurn("2026-04-30T10:00:02Z", "follow up"),
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "follow response"),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);

    const stats = await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.filesChanged).toBe(1);
    const after = (db
      .prepare("SELECT turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { turn_count: number }).turn_count;
    expect(after).toBe(4);

    reloaded.conn.closeDb();
  });

  it("prunes sessions whose JSONL file was deleted", async () => {
    const { reloaded, projectsDir } = await setup();
    const fileA = path.join(projectsDir, "C--dev-z", "stay.jsonl");
    const fileB = path.join(projectsDir, "C--dev-z", "go.jsonl");
    await writeJsonl(fileA, [
      userTurn("2026-04-30T10:00:00Z", "stay"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);
    await writeJsonl(fileB, [
      userTurn("2026-04-30T10:00:00Z", "go"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n
    ).toBe(2);

    await fs.rm(fileB);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const remaining = db
      .prepare("SELECT session_id FROM sessions ORDER BY session_id")
      .all() as Array<{ session_id: string }>;
    expect(remaining.map((r) => r.session_id)).toEqual(["stay"]);
    // Cascade — go.jsonl's children should be gone.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'go'").get() as { n: number }).n
    ).toBe(0);

    reloaded.conn.closeDb();
  });

  it("populates daily_costs from ingested sessions", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-pm", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "r1", [], {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      }),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare(
        "SELECT day, project_slug, model, turn_count, cost_usd FROM daily_costs WHERE day = '2026-04-30'"
      )
      .get() as
      | { day: string; project_slug: string; model: string; turn_count: number; cost_usd: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.day).toBe("2026-04-30");
    expect(row!.model).toBe("claude-sonnet-4-5");
    expect(row!.turn_count).toBe(1);
    expect(row!.cost_usd).toBeGreaterThan(0);

    reloaded.conn.closeDb();
  });

  it("extracts agent invocations from Agent tool calls", async () => {
    // Real Claude Code JSONL emits "Agent" (not "Task" — that's the Anthropic
    // API SDK's tool name). Match the existing classifier/agentParser.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-a", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "review this"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "Spawning a reviewer",
        [{ id: "tu_1", name: "Agent", input: { subagent_type: "code-reviewer", prompt: "..." } }]
      ),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare("SELECT agent_name FROM tool_uses WHERE tool_name = 'Agent'")
      .get() as { agent_name: string };
    expect(row.agent_name).toBe("code-reviewer");

    reloaded.conn.closeDb();
  });

  it("extracts skill invocations from Skill tool calls", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-sk", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "use a skill"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "Invoking",
        [{ id: "tu_1", name: "Skill", input: { skill: "simplify" } }]
      ),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare("SELECT skill_name FROM tool_uses WHERE tool_name = 'Skill'")
      .get() as { skill_name: string };
    expect(row.skill_name).toBe("simplify");

    reloaded.conn.closeDb();
  });

  it("parses MCP tool names into mcp_server / mcp_tool", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-mcp", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "query"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok", [
        { id: "tu_1", name: "mcp__postgres__query", input: { sql: "SELECT 1" } },
      ]),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const row = db
      .prepare("SELECT mcp_server, mcp_tool FROM tool_uses WHERE tool_name LIKE 'mcp__%'")
      .get() as { mcp_server: string; mcp_tool: string };
    expect(row.mcp_server).toBe("postgres");
    expect(row.mcp_tool).toBe("query");

    reloaded.conn.closeDb();
  });

  it("skips sidechain and meta entries", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-side", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "ask"),
      // Sidechain assistant turn — should be ignored.
      { ...assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "side"), isSidechain: true },
      // Meta entry — should be ignored.
      { ...assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "meta"), isMeta: true },
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "real reply"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const session = db
      .prepare("SELECT turn_count, assistant_turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { turn_count: number; assistant_turn_count: number };
    expect(session.turn_count).toBe(2);
    expect(session.assistant_turn_count).toBe(1);

    reloaded.conn.closeDb();
  });

  it("survives a file_path move with unchanged content", async () => {
    // Regression test: the no-op gate previously matched on session_id /
    // mtime / size only. A renamed file with identical content would skip
    // the ingest, then the prune pass would delete the row because the
    // old path was no longer in liveFilePaths. Including file_path in the
    // gate means a path-only change re-ingests so the row stays.
    const { reloaded, projectsDir } = await setup();
    const oldPath = path.join(projectsDir, "C--dev-old", "abc.jsonl");
    const newPath = path.join(projectsDir, "C--dev-new", "abc.jsonl");
    const entries: JsonlEntry[] = [
      userTurn("2026-04-30T10:00:00Z", "hi"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ];
    await writeJsonl(oldPath, entries);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'abc'").get() as { n: number }).n
    ).toBe(1);

    // Move the file (identical content, identical size; mtime may even
    // round-match). Reconcile must update file_path, not delete the row.
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.rename(oldPath, newPath);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const row = db
      .prepare("SELECT file_path, project_dir_name FROM sessions WHERE session_id = 'abc'")
      .get() as { file_path: string; project_dir_name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.file_path).toBe(newPath);

    reloaded.conn.closeDb();
  });

  it("tails a session: appends without changing existing turn_indexes", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-tail", "s1.jsonl");
    const initial: JsonlEntry[] = [
      userTurn("2026-04-30T10:00:00Z", "first prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "first reply"),
    ];
    await writeJsonl(sessionFile, initial);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const sessionRowBefore = db
      .prepare("SELECT byte_offset, file_size, turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { byte_offset: number; file_size: number; turn_count: number };
    expect(sessionRowBefore.turn_count).toBe(2);
    expect(sessionRowBefore.byte_offset).toBe(sessionRowBefore.file_size);
    const turnIndexesBefore = db
      .prepare("SELECT turn_index FROM turns WHERE session_id = 's1' ORDER BY turn_index")
      .all()
      .map((r: any) => r.turn_index);
    expect(turnIndexesBefore).toEqual([0, 1]);

    // Append two new turns to the file. Watcher would do this; we simulate
    // by appending the JSON lines directly so the existing prefix is
    // byte-for-byte identical (which is the precondition for tail).
    const tailEntries: JsonlEntry[] = [
      userTurn("2026-04-30T10:00:02Z", "follow up"),
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "follow reply"),
    ];
    await fs.appendFile(
      sessionFile,
      tailEntries.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Existing turn rows must NOT have changed turn_indexes — appended
    // turns get the next indexes.
    const turnIndexesAfter = db
      .prepare("SELECT turn_index FROM turns WHERE session_id = 's1' ORDER BY turn_index")
      .all()
      .map((r: any) => r.turn_index);
    expect(turnIndexesAfter).toEqual([0, 1, 2, 3]);

    const sessionRowAfter = db
      .prepare(
        "SELECT turn_count, assistant_turn_count, user_turn_count, byte_offset, file_size FROM sessions WHERE session_id = 's1'"
      )
      .get() as {
      turn_count: number;
      assistant_turn_count: number;
      user_turn_count: number;
      byte_offset: number;
      file_size: number;
    };
    expect(sessionRowAfter.turn_count).toBe(4);
    expect(sessionRowAfter.assistant_turn_count).toBe(2);
    expect(sessionRowAfter.user_turn_count).toBe(2);
    expect(sessionRowAfter.byte_offset).toBe(sessionRowAfter.file_size);

    reloaded.conn.closeDb();
  });

  it("falls back to full re-parse when the file shrinks", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-shrink", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "long prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "long reply"),
      userTurn("2026-04-30T10:00:02Z", "another prompt"),
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "another reply"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      (db
        .prepare("SELECT turn_count FROM sessions WHERE session_id = 's1'")
        .get() as { turn_count: number }).turn_count
    ).toBe(4);

    // Truncate to a smaller content set — simulates a session that was
    // rewritten / compacted. Cursor is invalid; reconcile must fall
    // back to full re-parse.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "short"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const turn = (db
      .prepare("SELECT turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { turn_count: number });
    expect(turn.turn_count).toBe(2);

    // FK cascade should have removed the orphaned turns from the previous
    // 4-turn version.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 's1'").get() as { n: number })
        .n
    ).toBe(2);

    reloaded.conn.closeDb();
  });

  it("tail rehydration preserves toolResultText for the one-shot detector", async () => {
    // Regression test for PR #40 review: rehydrating user turns from
    // `text_preview` alone lost the tool-result content that
    // detectOneShot's error-pattern check relies on. After tail-append,
    // a previously-FAILED verification would look like "no error" and
    // has_one_shot would flip to true incorrectly.
    //
    // Build a session where the FIRST cycle's verification fails
    // (Edit → Bash(test) → result with "FAIL"), then tail-append a
    // SECOND cycle that succeeds. detectOneShot should count one
    // verified task (the second cycle) as one-shot — not two —
    // because the rehydrated first cycle still carries the failure.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-rehy", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "fix it"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "first edit",
        [{ id: "tu_e1", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }]
      ),
      assistantTurn(
        "2026-04-30T10:00:02Z",
        "claude-sonnet-4-5",
        "verifying",
        [{ id: "tu_b1", name: "Bash", input: { command: "npm test" } }]
      ),
      {
        type: "user" as const,
        timestamp: "2026-04-30T10:00:03Z",
        // Verification failed — the result text contains FAIL.
        message: { content: [{ type: "tool_result", content: "FAIL: tests broke", tool_use_id: "tu_b1" }] },
      },
      // Re-edit (the failure path: another Edit appears, marking the
      // first cycle as not-one-shot).
      assistantTurn(
        "2026-04-30T10:00:04Z",
        "claude-sonnet-4-5",
        "second edit",
        [{ id: "tu_e2", name: "Edit", input: { file_path: "/x.ts", old_string: "b", new_string: "c" } }]
      ),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Sanity: the failure should have been recorded — tool_result_preview
    // for the failing user turn must contain "FAIL" so the detector can
    // see it on rehydrate.
    const userTurnWithResult = db
      .prepare("SELECT tool_result_preview FROM turns WHERE session_id = 's1' AND role = 'user' AND tool_result_preview IS NOT NULL")
      .get() as { tool_result_preview: string };
    expect(userTurnWithResult.tool_result_preview).toContain("FAIL");

    // Append a SECOND cycle that succeeds. The tail-append rehydrates
    // the prior turns including the failing tool_result; if rehydration
    // works, the detector treats cycle 1 as failed (correct) and cycle 2
    // as one-shot (correct) — has_one_shot = 1 because cycle 2 succeeded.
    await fs.appendFile(
      sessionFile,
      [
        assistantTurn(
          "2026-04-30T10:00:05Z",
          "claude-sonnet-4-5",
          "verifying again",
          [{ id: "tu_b2", name: "Bash", input: { command: "npm test" } }]
        ),
        {
          type: "user" as const,
          timestamp: "2026-04-30T10:00:06Z",
          message: { content: [{ type: "tool_result", content: "all tests passed", tool_use_id: "tu_b2" }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      (db
        .prepare("SELECT has_one_shot FROM sessions WHERE session_id = 's1'")
        .get() as { has_one_shot: number }).has_one_shot
    ).toBe(1);

    reloaded.conn.closeDb();
  });

  it("tail re-runs detectOneShot over old + new combined", async () => {
    // detectOneShot looks at sliding windows of turns: an Edit appended
    // alone wouldn't flag has_one_shot, but Edit + Bash(test) + result
    // -with-no-error does. Verify a tail can flip the verdict by
    // appending only the verification turn.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-shot", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "fix it"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "editing",
        [{ id: "tu_e", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }]
      ),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      (db
        .prepare("SELECT has_one_shot FROM sessions WHERE session_id = 's1'")
        .get() as { has_one_shot: number }).has_one_shot
    ).toBe(0);

    // Append a verification turn (Bash test) and a successful tool result.
    await fs.appendFile(
      sessionFile,
      [
        assistantTurn(
          "2026-04-30T10:00:02Z",
          "claude-sonnet-4-5",
          "verifying",
          [{ id: "tu_b", name: "Bash", input: { command: "npm test" } }]
        ),
        {
          type: "user" as const,
          timestamp: "2026-04-30T10:00:03Z",
          message: { content: [{ type: "tool_result", content: "all tests passed", tool_use_id: "tu_b" }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      (db
        .prepare("SELECT has_one_shot FROM sessions WHERE session_id = 's1'")
        .get() as { has_one_shot: number }).has_one_shot
    ).toBe(1);

    reloaded.conn.closeDb();
  });

  it("doesn't advance byte_offset past a partial trailing line", async () => {
    // Regression test for the byte_offset advancement bug: if the writer
    // is mid-flush, an incomplete final line should NOT move the cursor
    // past it — otherwise the line is permanently dropped when the
    // writer finishes.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-mid", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "first"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "first reply"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const cursorAfterClean = (db
      .prepare("SELECT byte_offset, file_size FROM sessions WHERE session_id = 's1'")
      .get() as { byte_offset: number; file_size: number });
    expect(cursorAfterClean.byte_offset).toBe(cursorAfterClean.file_size);

    // Append a complete line followed by a partial line (no trailing \n)
    // — simulating a writer mid-flush.
    const completeLine = JSON.stringify(
      assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "second reply")
    ) + "\n";
    const partial = '{"type":"assistant","timestamp":"2026-04-30T10:00:03Z","mess';
    await fs.appendFile(sessionFile, completeLine + partial);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const cursorAfterPartial = (db
      .prepare("SELECT byte_offset, file_size, turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { byte_offset: number; file_size: number; turn_count: number });
    // The complete line was ingested (turn 0 user, turn 1 assistant,
    // turn 2 assistant from the appended complete line — partial is NOT
    // a turn yet).
    expect(cursorAfterPartial.turn_count).toBe(3);
    // Cursor parked at end of the complete line, NOT at file_size.
    expect(cursorAfterPartial.byte_offset).toBeLessThan(cursorAfterPartial.file_size);
    expect(cursorAfterPartial.byte_offset).toBe(
      cursorAfterPartial.file_size - Buffer.byteLength(partial, "utf8")
    );

    // Now flush the partial line — append the rest + newline. The next
    // reconcile must pick up the previously-partial line as a new turn.
    const completed =
      'age":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"third"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n';
    await fs.appendFile(sessionFile, completed);
    const further = new Date(Date.now() + 10000);
    await fs.utimes(sessionFile, further, further);

    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const final = (db
      .prepare("SELECT byte_offset, file_size, turn_count FROM sessions WHERE session_id = 's1'")
      .get() as { byte_offset: number; file_size: number; turn_count: number });
    expect(final.turn_count).toBe(4); // the previously-partial turn now ingested
    expect(final.byte_offset).toBe(final.file_size);

    reloaded.conn.closeDb();
  });

  it("recovers Bash command from truncated arguments_json on rehydrate", async () => {
    // Regression test: a Bash command whose JSON-stringified args exceed
    // ARGS_JSON_LIMIT gets truncated to invalid JSON. Rehydration must
    // still surface the `command` field so detectOneShot can see it.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-trunc", "s1.jsonl");
    // Build a Bash command long enough to bust the 32 KB cap.
    const longCommand = "npm test " + "X".repeat(40_000);
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "fix it"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "editing",
        [{ id: "tu_e", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }]
      ),
      assistantTurn(
        "2026-04-30T10:00:02Z",
        "claude-sonnet-4-5",
        "verifying",
        [{ id: "tu_b", name: "Bash", input: { command: longCommand } }]
      ),
      {
        type: "user" as const,
        timestamp: "2026-04-30T10:00:03Z",
        message: { content: [{ type: "tool_result", content: "all tests passed", tool_use_id: "tu_b" }] },
      },
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Stored args were truncated past the close-quote — confirm.
    const stored = (db
      .prepare("SELECT arguments_json FROM tool_uses WHERE tool_name = 'Bash'")
      .get() as { arguments_json: string });
    let parseFailed = false;
    try {
      JSON.parse(stored.arguments_json);
    } catch {
      parseFailed = true;
    }
    expect(parseFailed).toBe(true);

    // Append a NEW user prompt to trigger a tail-append. The tail rerun
    // of detectOneShot must rehydrate the Bash turn's `command` field
    // (via parseStoredArgs's fallback regex) and correctly classify the
    // edit-verify-success cycle as one-shot.
    await fs.appendFile(
      sessionFile,
      JSON.stringify(userTurn("2026-04-30T10:00:04Z", "anything else?")) + "\n"
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      (db
        .prepare("SELECT has_one_shot FROM sessions WHERE session_id = 's1'")
        .get() as { has_one_shot: number }).has_one_shot
    ).toBe(1);

    reloaded.conn.closeDb();
  });

  it("refreshes daily_costs for the OLD day when a turn moves between days", async () => {
    // Regression test: re-ingesting a session that moves an assistant
    // turn from day X to day Y previously left day X's daily_costs row
    // holding stale token/cost totals from the deleted turn. Now we
    // collect the OLD session's tuples before replace and union them
    // with the new ones for the refresh.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-shift", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "before"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "day X reply", [], {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      }),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE day = '2026-04-30'")
        .get() as { n: number }).n
    ).toBe(1);

    // Re-ingest with the assistant turn moved to a different day.
    await writeJsonl(sessionFile, [
      userTurn("2026-05-01T10:00:00Z", "after"),
      assistantTurn("2026-05-01T10:00:01Z", "claude-sonnet-4-5", "day Y reply", [], {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      }),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Day X should be gone (no remaining assistant turns), day Y populated.
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE day = '2026-04-30'")
        .get() as { n: number }).n
    ).toBe(0);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE day = '2026-05-01'")
        .get() as { n: number }).n
    ).toBe(1);

    reloaded.conn.closeDb();
  });
});
