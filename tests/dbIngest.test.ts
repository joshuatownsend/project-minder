import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { UsageTurn } from "@/lib/usage/types";
import type { SessionFile } from "@/lib/adapters/types";
import type { MinderConfig } from "@/lib/types";

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
  data: typeof import("@/lib/data");
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
  const data = await import("@/lib/data");
  return { conn, mig, ingest, data };
}

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
  content?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
  slug?: string;
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
  }> = {},
  extra: Partial<{ slug: string; stop_reason: string }> = {}
): JsonlEntry {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  const entry: JsonlEntry = {
    type: "assistant",
    timestamp,
    message: {
      model,
      content,
      stop_reason: extra.stop_reason,
      usage: {
        input_tokens: usage.input_tokens ?? 100,
        output_tokens: usage.output_tokens ?? 50,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  };
  if (extra.slug) entry.slug = extra.slug;
  return entry;
}

/**
 * Build a user turn carrying a tool_result block — the shape Claude Code
 * uses to feed tool output back into the conversation. Used by the
 * pending-pair status tests below.
 */
function userToolResultTurn(timestamp: string, toolUseId: string, output: string): JsonlEntry {
  return {
    type: "user",
    timestamp,
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
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
    expect(session.derived_version).toBe(9);
    expect(session.source).toBe("claude");

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

  it("extracts initial_prompt / last_prompt from string message.content (real Claude Code user-turn shape)", async () => {
    // Real Claude Code JSONL stores human-typed user turns with
    // `message.content` as a STRING (not an array of typed blocks like
    // assistant turns use). Earlier the DB ingest pipeline ran
    // `extractText()` — which is array-only — on the string and got back
    // "", so `initial_prompt` / `last_prompt` ended up empty for every
    // real session and Home's Live activity card read "(no prompt)" for
    // all of them. This test asserts the string-content path now lands
    // the prompt on the sessions row. The pre-existing `userTurn()` helper
    // in this file uses ARRAY content, so the array path is also still
    // covered by every other test in this suite.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-strprompt", "str-session.jsonl");
    await writeJsonl(sessionFile, [
      {
        type: "user",
        timestamp: "2026-04-30T10:00:00Z",
        message: { content: "fix the build please" },
      },
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "On it.",
        [],
        { input_tokens: 50, output_tokens: 20 }
      ),
      {
        type: "user",
        timestamp: "2026-04-30T10:00:05Z",
        message: { content: "actually also add a test" },
      },
    ]);

    const db = (await reloaded.conn.getDb())!;
    const stats = await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);

    const session = db
      .prepare("SELECT initial_prompt, last_prompt FROM sessions WHERE session_id = 'str-session'")
      .get() as { initial_prompt: string | null; last_prompt: string | null };
    expect(session.initial_prompt).toBe("fix the build please");
    expect(session.last_prompt).toBe("actually also add a test");

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

  // ── Status snapshot at ingest (P2c contract reinforced in Wave 2) ──────
  //
  // The schema's `sessions.status` CHECK constraint allows seven values
  // but ingest only writes two — `'waiting'` (last assistant turn has
  // unresolved tool_uses) or `'inactive'` (no pendings). The read-side
  // loader time-gates `'waiting'` against `file_mtime_ms` to derive the
  // `working / needs_attention / idle` triplet the UI consumes. These
  // tests cover the ingest snapshot side; loader-side gating is covered
  // by the dataSessionsList parity test.

  it("status snapshot: 'inactive' when last assistant ended with end_turn and no pending tools", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-status", "clean-end.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "say hello"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "hello!",
        [],
        {},
        { stop_reason: "end_turn" }
      ),
    ]);
    const stats = await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    expect(stats.errors).toBe(0);
    const db = (await reloaded.conn.getDb())!;
    const row = db
      .prepare("SELECT status FROM sessions WHERE session_id = 'clean-end'")
      .get() as { status: string };
    expect(row.status).toBe("inactive");
    reloaded.conn.closeDb();
  });

  it("status snapshot: 'waiting' when last assistant has unresolved tool_use", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-status", "pending.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "do the thing"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "running",
        [{ id: "tu_unfinished", name: "Bash", input: { command: "sleep 1" } }],
        {},
        { stop_reason: "tool_use" }
      ),
      // No matching tool_result — the last assistant turn's pending stays
      // unresolved. Ingest should record `'waiting'`.
    ]);
    await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    const db = (await reloaded.conn.getDb())!;
    const row = db
      .prepare("SELECT status FROM sessions WHERE session_id = 'pending'")
      .get() as { status: string };
    expect(row.status).toBe("waiting");
    reloaded.conn.closeDb();
  });

  it("status snapshot: 'inactive' when pending tools were resolved by a later user turn", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-status", "resolved.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "do the thing"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "running",
        [{ id: "tu_resolved", name: "Bash", input: { command: "echo hi" } }],
        {},
        { stop_reason: "tool_use" }
      ),
      userToolResultTurn("2026-04-30T10:00:02Z", "tu_resolved", "hi"),
    ]);
    await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    const db = (await reloaded.conn.getDb())!;
    const row = db
      .prepare("SELECT status FROM sessions WHERE session_id = 'resolved'")
      .get() as { status: string };
    expect(row.status).toBe("inactive");
    reloaded.conn.closeDb();
  });

  // ── Slug + continuation tracking (Wave 2 / TODO #150) ──────────────────

  it("captures the per-session slug from any assistant entry", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-slug", "with-slug.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "hello"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "hi",
        [],
        {},
        { slug: "quirky-scribbling-plum", stop_reason: "end_turn" }
      ),
    ]);
    await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    const db = (await reloaded.conn.getDb())!;
    const row = db
      .prepare("SELECT slug FROM sessions WHERE session_id = 'with-slug'")
      .get() as { slug: string | null };
    expect(row.slug).toBe("quirky-scribbling-plum");
    reloaded.conn.closeDb();
  });

  it("links continuations: oldest session has no parent; later one points to the previous", async () => {
    // Two synthetic sessions sharing the same slug — the only way to
    // verify continuation linking, per advisor note, since the user's
    // PM corpus has zero duplicates today.
    const { reloaded, projectsDir } = await setup();
    const projectDir = path.join(projectsDir, "C--dev-cont");
    await writeJsonl(path.join(projectDir, "first-uuid.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "begin"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "starting",
        [],
        {},
        { slug: "shared-pondering-otter", stop_reason: "end_turn" }
      ),
    ]);
    // Second session: same slug, later start_ts. Should be linked to the
    // first via `continued_from_session_id`.
    await writeJsonl(path.join(projectDir, "second-uuid.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "continuing"),
      assistantTurn(
        "2026-04-30T11:00:01Z",
        "claude-sonnet-4-5",
        "resuming",
        [],
        {},
        { slug: "shared-pondering-otter", stop_reason: "end_turn" }
      ),
    ]);
    await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    const db = (await reloaded.conn.getDb())!;
    const rows = db
      .prepare(
        "SELECT session_id, slug, continued_from_session_id FROM sessions ORDER BY start_ts"
      )
      .all() as Array<{ session_id: string; slug: string; continued_from_session_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].continued_from_session_id).toBeNull(); // oldest
    expect(rows[1].continued_from_session_id).toBe("first-uuid");
    reloaded.conn.closeDb();
  });

  // ── Quality signals (context_fill, compaction loop, tool-failure streak) ──

  it("stamps context_fill on assistant turns and max_context_fill on session", async () => {
    // claude-sonnet-4-5 → 200 K window
    // turn 1: 200 input → fill = 200 / 200_000 = 0.001
    // turn 2: 1000 input → fill = 1000 / 200_000 = 0.005  ← max
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-fill", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "prompt"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "r1", [], { input_tokens: 200, output_tokens: 50 }),
      assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "r2", [], { input_tokens: 1000, output_tokens: 50 }),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const turnRows = db
      .prepare("SELECT role, context_fill FROM turns WHERE session_id = 's1' ORDER BY turn_index")
      .all() as Array<{ role: string; context_fill: number | null }>;
    expect(turnRows[0].context_fill).toBeNull(); // user turn gets no fill
    expect(turnRows[1].context_fill).toBeCloseTo(200 / 200_000, 10);
    expect(turnRows[2].context_fill).toBeCloseTo(1000 / 200_000, 10);

    const session = db
      .prepare("SELECT max_context_fill, has_compaction_loop FROM sessions WHERE session_id = 's1'")
      .get() as { max_context_fill: number | null; has_compaction_loop: number };
    expect(session.max_context_fill).toBeCloseTo(1000 / 200_000, 10);
    expect(session.has_compaction_loop).toBe(0); // fill too low to trigger

    reloaded.conn.closeDb();
  });

  it("sets has_compaction_loop = 1 for consecutive near-identical high-fill turns", async () => {
    // Three assistant turns all at ~77 % fill with < 10 % variance between
    // consecutive pairs — exactly the compaction-loop heuristic spec.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-loop", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "long task"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "r1", [], { input_tokens: 155_000, output_tokens: 500 }),
      assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "r2", [], { input_tokens: 154_000, output_tokens: 500 }),
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "r3", [], { input_tokens: 156_000, output_tokens: 500 }),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const session = db
      .prepare("SELECT has_compaction_loop, max_context_fill FROM sessions WHERE session_id = 's1'")
      .get() as { has_compaction_loop: number; max_context_fill: number };
    expect(session.has_compaction_loop).toBe(1);
    expect(session.max_context_fill).toBeCloseTo(156_000 / 200_000, 5);

    reloaded.conn.closeDb();
  });

  it("sets has_tool_failure_streak = 1 after repeated errors past the grace period", async () => {
    // The detector skips the first 6 turns (grace period). After that, 5
    // consecutive evaluable user turns all carrying "Error:" content →
    // 100% failure rate → streak fires.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-streak", "s1.jsonl");
    await writeJsonl(sessionFile, [
      // Grace period — turn indices 0-5
      userTurn("2026-04-30T10:00:00Z", "start"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
      userTurn("2026-04-30T10:00:02Z", "next"),
      assistantTurn("2026-04-30T10:00:03Z", "claude-sonnet-4-5", "ok"),
      userTurn("2026-04-30T10:00:04Z", "more"),
      assistantTurn("2026-04-30T10:00:05Z", "claude-sonnet-4-5", "ok"),
      // Post-grace evaluable turns — all carry error content
      userToolResultTurn("2026-04-30T10:00:06Z", "tu1", "Error: something failed"),
      assistantTurn("2026-04-30T10:00:07Z", "claude-sonnet-4-5", "retrying"),
      userToolResultTurn("2026-04-30T10:00:08Z", "tu2", "Error: something failed"),
      assistantTurn("2026-04-30T10:00:09Z", "claude-sonnet-4-5", "retrying"),
      userToolResultTurn("2026-04-30T10:00:10Z", "tu3", "Error: something failed"),
      assistantTurn("2026-04-30T10:00:11Z", "claude-sonnet-4-5", "retrying"),
      userToolResultTurn("2026-04-30T10:00:12Z", "tu4", "Error: something failed"),
      assistantTurn("2026-04-30T10:00:13Z", "claude-sonnet-4-5", "retrying"),
      userToolResultTurn("2026-04-30T10:00:14Z", "tu5", "Error: something failed"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const session = db
      .prepare("SELECT has_tool_failure_streak FROM sessions WHERE session_id = 's1'")
      .get() as { has_tool_failure_streak: number };
    expect(session.has_tool_failure_streak).toBe(1);

    reloaded.conn.closeDb();
  });

  it("tail-append re-runs quality detectors and updates max_context_fill", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-tail-q", "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "initial"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "r1", [], { input_tokens: 100 }),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const before = db
      .prepare("SELECT max_context_fill FROM sessions WHERE session_id = 's1'")
      .get() as { max_context_fill: number | null };
    expect(before.max_context_fill).toBeCloseTo(100 / 200_000, 10);

    // Tail-append a turn with much higher fill; quality should update.
    await fs.appendFile(
      sessionFile,
      JSON.stringify(
        assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "r2", [], { input_tokens: 50_000 })
      ) + "\n"
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const after = db
      .prepare("SELECT max_context_fill FROM sessions WHERE session_id = 's1'")
      .get() as { max_context_fill: number | null };
    expect(after.max_context_fill).toBeCloseTo(50_000 / 200_000, 6);

    reloaded.conn.closeDb();
  });

  it("does NOT link sessions with different slugs even within the same project", async () => {
    const { reloaded, projectsDir } = await setup();
    const projectDir = path.join(projectsDir, "C--dev-cont2");
    await writeJsonl(path.join(projectDir, "alpha.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "alpha"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "ok",
        [],
        {},
        { slug: "first-slug", stop_reason: "end_turn" }
      ),
    ]);
    await writeJsonl(path.join(projectDir, "beta.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "beta"),
      assistantTurn(
        "2026-04-30T11:00:01Z",
        "claude-sonnet-4-5",
        "ok",
        [],
        {},
        { slug: "second-slug", stop_reason: "end_turn" }
      ),
    ]);
    await reloaded.ingest.reconcileAllSessions(
      (await reloaded.conn.getDb())!,
      { projectsDir }
    );
    const db = (await reloaded.conn.getDb())!;
    const rows = db
      .prepare(
        "SELECT session_id, continued_from_session_id FROM sessions ORDER BY start_ts"
      )
      .all() as Array<{ session_id: string; continued_from_session_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].continued_from_session_id).toBeNull();
    expect(rows[1].continued_from_session_id).toBeNull();
    reloaded.conn.closeDb();
  });

  it("re-parses existing sessions on schema-v5 upgrade so slug populates", async () => {
    // Simulates the upgrade path: a v4-shaped DB has existing session
    // rows from a prior DERIVED_VERSION (3) with NULL slug. The v5
    // migration adds the slug column; the DERIVED_VERSION bump to 4
    // forces `reconcileSessionFile` to re-parse despite mtime+size
    // being unchanged — that's what populates slug from JSONL.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-upgrade", "abc.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "hi"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "ok",
        [],
        {},
        { slug: "graceful-pivoting-ferret", stop_reason: "end_turn" }
      ),
    ]);
    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Simulate a v4-era pre-upgrade row: clear slug + roll back
    // derived_version. mtime/size left untouched.
    db.prepare("UPDATE sessions SET slug = NULL, derived_version = 3 WHERE session_id = 'abc'").run();
    expect(
      (db.prepare("SELECT slug FROM sessions WHERE session_id = 'abc'").get() as { slug: string | null })
        .slug
    ).toBeNull();

    // Re-running reconcile after the version bump: the file is unchanged
    // but `derived_version < DERIVED_VERSION` so the skip-gate must
    // trigger a full re-parse.
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    const row = db
      .prepare("SELECT slug, derived_version FROM sessions WHERE session_id = 'abc'")
      .get() as { slug: string | null; derived_version: number };
    expect(row.slug).toBe("graceful-pivoting-ferret");
    expect(row.derived_version).toBe(9);
    reloaded.conn.closeDb();
  });

  // T2.2 — session_prs write-path integration tests. These prove the
  // extractor → ParsedSession.prs → writeSession/appendSessionTail →
  // session_prs DB rows pipeline end-to-end, catching the regression risk
  // code review #15 flagged: refactors that silently drop the field would
  // pass every unit test today.

  it("persists session_prs rows from `gh pr create` Bash tool_result", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-prapp", "pr1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "open a PR"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "Opening it now",
        [{ id: "tu_pr", name: "Bash", input: { command: "gh pr create --fill" } }],
      ),
      userToolResultTurn("2026-04-30T10:00:02Z", "tu_pr", "https://github.com/foo/bar/pull/42"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const prs = db
      .prepare(
        "SELECT pr_url, pr_number, repo FROM session_prs WHERE session_id = 'pr1' ORDER BY pr_number",
      )
      .all() as Array<{ pr_url: string; pr_number: number; repo: string }>;
    expect(prs).toEqual([
      {
        pr_url: "https://github.com/foo/bar/pull/42",
        pr_number: 42,
        repo: "foo/bar",
      },
    ]);
    reloaded.conn.closeDb();
  });

  it("persists multiple session_prs rows, sorted by pr_number on read", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-multipr", "multi.jsonl");
    // Encounter order is 200, 5 (a later --continue session opens an older
    // PR). DB read must order by pr_number ascending — review #7 made the
    // file-parse extractor sort the same way so both backends agree.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "first PR"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "creating",
        [{ id: "tu_a", name: "Bash", input: { command: "gh pr create --title a" } }],
      ),
      userToolResultTurn("2026-04-30T10:00:02Z", "tu_a", "https://github.com/foo/bar/pull/200"),
      userTurn("2026-04-30T10:00:03Z", "second PR"),
      assistantTurn(
        "2026-04-30T10:00:04Z",
        "claude-sonnet-4-5",
        "creating",
        [{ id: "tu_b", name: "Bash", input: { command: "gh pr create --title b" } }],
      ),
      userToolResultTurn("2026-04-30T10:00:05Z", "tu_b", "https://github.com/foo/bar/pull/5"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const numbers = (
      db
        .prepare(
          "SELECT pr_number FROM session_prs WHERE session_id = 'multi' ORDER BY pr_number",
        )
        .all() as Array<{ pr_number: number }>
    ).map((r) => r.pr_number);
    expect(numbers).toEqual([5, 200]);
    reloaded.conn.closeDb();
  });

  it("preserves existing session_prs rows when a re-parse extractor returns []", async () => {
    // Code review #2: `safeExtractPrs` swallows extractor errors and
    // returns []. writeSession's DELETE-then-reinsert pattern would
    // otherwise cascade through the FK and wipe every prior PR. The fix
    // saves rows before DELETE and merges them back; verify the prior PR
    // survives an empty re-extract.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-preserve", "p1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "open it"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "ok",
        [{ id: "tu_x", name: "Bash", input: { command: "gh pr create --fill" } }],
      ),
      userToolResultTurn("2026-04-30T10:00:02Z", "tu_x", "https://github.com/foo/bar/pull/77"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Manually wipe the bash call from the file (simulating an extractor
    // that returns [] after a content-shape change) and bump mtime to
    // force a re-parse. The session row will go through DELETE→cascade →
    // re-insert; without the preservation fix the PR would vanish.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "open it"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "ok",
        // No `gh pr create` here — fresh extract returns [].
      ),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const prs = db
      .prepare("SELECT pr_url FROM session_prs WHERE session_id = 'p1'")
      .all() as Array<{ pr_url: string }>;
    expect(prs).toEqual([{ pr_url: "https://github.com/foo/bar/pull/77" }]);
    reloaded.conn.closeDb();
  });

  // item3 — session_tickets write-path integration. Tickets come from a
  // plain all-text scan (no `gh … create` pairing), so a URL in a prompt
  // is enough; the riskiest new code is the preserve-then-merge on rewrite.

  it("persists session_tickets rows from a referenced ticket URL", async () => {
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-tkt", "tk1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn(
        "2026-04-30T10:00:00Z",
        "work on https://linear.app/acme/issue/ENG-7 and https://github.com/foo/bar/issues/9",
      ),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "on it"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const rows = db
      .prepare(
        "SELECT url, provider, ticket_key FROM session_tickets WHERE session_id = 'tk1' ORDER BY provider, ticket_key",
      )
      .all() as Array<{ url: string; provider: string; ticket_key: string }>;
    expect(rows).toEqual([
      { url: "https://github.com/foo/bar/issues/9", provider: "github", ticket_key: "foo/bar#9" },
      { url: "https://linear.app/acme/issue/ENG-7", provider: "linear", ticket_key: "ENG-7" },
    ]);
    reloaded.conn.closeDb();
  });

  it("preserves existing session_tickets rows when a re-parse finds none", async () => {
    // Ticket analogue of the session_prs preservation test: writeSession's
    // DELETE→cascade→re-insert would wipe prior tickets if the fresh extract
    // returns nothing. `preservedTickets` + `mergeTicketLinks` must keep them.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-tktpreserve", "tp1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "fixes https://github.com/foo/bar/issues/55"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Rewrite without the URL and bump mtime to force a full re-parse whose
    // fresh extract yields []. Without preservation the ticket would vanish.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "no ticket here anymore"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    const rows = db
      .prepare("SELECT url FROM session_tickets WHERE session_id = 'tp1'")
      .all() as Array<{ url: string }>;
    expect(rows).toEqual([{ url: "https://github.com/foo/bar/issues/55" }]);
    reloaded.conn.closeDb();
  });

  it("recovers a straddled PR via tail-pass full re-extraction", async () => {
    // Code review #1: when the `gh pr create` Bash call lands in already-
    // persisted bytes and the tool_result arrives in a later tail-append,
    // the tail extractor sees only an orphan `tool_result` with no
    // matching `tool_use_id`. The recovery path in `reconcileSessionFile`
    // does a full-file PR re-extract to catch it.
    const { reloaded, projectsDir } = await setup();
    const sessionFile = path.join(projectsDir, "C--dev-straddle", "s1.jsonl");

    // First write: just the user prompt + the assistant Bash call. No
    // tool_result yet — simulates the writer flushing mid-conversation.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "ship the PR"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "creating",
        [{ id: "tu_straddle", name: "Bash", input: { command: "gh pr create --fill" } }],
      ),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    // No PR yet — the result hasn't been written.
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM session_prs WHERE session_id = 's1'").get() as { n: number }
      ).n,
    ).toBe(0);

    // Append the tool_result in a SEPARATE write. The cursor is parked
    // past the assistant turn, so the next reconcile's tail-parse sees
    // ONLY the new user turn — orphan tool_use_id, no matching call.
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "ship the PR"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        "creating",
        [{ id: "tu_straddle", name: "Bash", input: { command: "gh pr create --fill" } }],
      ),
      userToolResultTurn(
        "2026-04-30T10:00:02Z",
        "tu_straddle",
        "https://github.com/foo/bar/pull/88",
      ),
    ]);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(sessionFile, future, future);
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });

    // Recovery should have caught the PR via the full-file re-extract.
    const prs = db
      .prepare("SELECT pr_url, pr_number FROM session_prs WHERE session_id = 's1'")
      .all() as Array<{ pr_url: string; pr_number: number }>;
    expect(prs).toEqual([
      { pr_url: "https://github.com/foo/bar/pull/88", pr_number: 88 },
    ]);
    reloaded.conn.closeDb();
  });
});

describe.skipIf(!driverAvailable)("reconcileAllSessions — non-Claude adapter pass", () => {
  async function setup(): Promise<{ reloaded: Reloaded; projectsDir: string }> {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();
    expect(init.available).toBe(true);
    return { reloaded, projectsDir: path.join(tmpHome, ".claude", "projects") };
  }

  function cfg(enabledAdapters: string[]): MinderConfig {
    return { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters };
  }

  function uUser(ts: string, text: string, sessionId: string, slug = "codexproj"): UsageTurn {
    return {
      timestamp: ts, sessionId, projectSlug: slug, projectDirName: slug,
      model: "", role: "user", inputTokens: 0, outputTokens: 0,
      cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], userMessageText: text,
    };
  }
  function uAsst(
    ts: string, model: string, text: string, sessionId: string,
    toolCalls: UsageTurn["toolCalls"] = [], slug = "codexproj"
  ): UsageTurn {
    return {
      timestamp: ts, sessionId, projectSlug: slug, projectDirName: slug,
      model, role: "assistant", inputTokens: 200, outputTokens: 100,
      cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls, assistantText: text,
    };
  }

  async function makeCodexFile(name = "rollout-xyz.jsonl"): Promise<string> {
    const fp = path.join(tmpHome, ".codex", "sessions", name);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, "x"); // content irrelevant; parseAdapterFile is mocked
    return fp;
  }

  // ── Unit: buildAdapterParsedSession (pure conversion) ──────────────────
  it("buildAdapterParsedSession derives source/sessionId/cost/category from UsageTurn[]", async () => {
    const { reloaded } = await setup();
    const file: SessionFile = {
      source: "codex",
      filePath: "/home/u/.codex/sessions/r1.jsonl",
      projectDirName: "codexproj",
    };
    const turns: UsageTurn[] = [
      uUser("2026-05-01T10:00:00Z", "build a parser", "cx-real-id"),
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "on it", "cx-real-id", [
        { name: "Read", arguments: { file_path: "/repo/a.ts" } },
      ]),
      uAsst("2026-05-01T10:00:02Z", "gpt-5", "done", "cx-real-id", [
        { name: "Edit", arguments: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" } },
      ]),
    ];
    const parsed = reloaded.ingest.buildAdapterParsedSession(file, turns, 1_700_000_000_000, 1234)!;
    expect(parsed).not.toBeNull();
    expect(parsed.source).toBe("codex"); // NOT hardcoded "claude"
    expect(parsed.sessionId).toBe("cx-real-id"); // from turns, NOT filename "r1"
    expect(parsed.projectSlug).toBe("codexproj");
    expect(parsed.turnCount).toBe(3);
    expect(parsed.userTurnCount).toBe(1);
    expect(parsed.assistantTurnCount).toBe(2);
    expect(parsed.toolCallCount).toBe(2);
    expect(parsed.primaryModel).toBe("gpt-5");
    expect(parsed.costUsd).toBeGreaterThan(0);
    expect(parsed.startTs).toBe("2026-05-01T10:00:00Z");
    expect(parsed.endTs).toBe("2026-05-01T10:00:02Z");
    expect(parsed.initialPrompt).toBe("build a parser");
    expect(parsed.byteOffset).toBe(1234);
    // assistant turns classified, user turn not
    expect(parsed.turns[0].category).toBeNull();
    expect(parsed.turns[1].category).toBeTypeOf("string");
    // affected rollup tuple keyed on the real slug + model
    expect([...parsed.affectedDays]).toContain("2026-05-01|codexproj|gpt-5");
    reloaded.conn.closeDb();
  });

  it("buildAdapterParsedSession returns null for an empty session", async () => {
    const { reloaded } = await setup();
    const file: SessionFile = { source: "gemini", filePath: "/x/s.json", projectDirName: "p" };
    expect(reloaded.ingest.buildAdapterParsedSession(file, [], 1, 0)).toBeNull();
    reloaded.conn.closeDb();
  });

  // ── Integration: discover → parse → write via the reconcile seams ──────
  it("ingests a non-Claude session with source/sessionId/turns/tool_uses", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    const codexFile = await makeCodexFile();
    const adapterSessions: SessionFile[] = [
      { source: "codex", filePath: codexFile, projectDirName: "codexproj" },
    ];
    const parseAdapterFile = vi.fn(async (_f: SessionFile): Promise<UsageTurn[]> => [
      uUser("2026-05-01T10:00:00Z", "hello", "cx-1"),
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1", [
        { name: "Edit", arguments: { file_path: "/repo/x.ts", old_string: "a", new_string: "b" } },
      ]),
    ]);

    const stats = await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude", "codex"]), adapterSessions, parseAdapterFile,
    });
    expect(stats.errors).toBe(0);
    expect(stats.filesChanged).toBe(1);

    const session = db.prepare("SELECT * FROM sessions WHERE session_id = 'cx-1'").get() as any;
    expect(session).toBeDefined();
    expect(session.source).toBe("codex");
    expect(session.primary_model).toBe("gpt-5");
    expect(session.cost_usd).toBeGreaterThan(0);
    expect(session.assistant_turn_count).toBe(1);

    const turns = db
      .prepare("SELECT role FROM turns WHERE session_id = 'cx-1' ORDER BY turn_index")
      .all();
    expect(turns).toHaveLength(2);
    const tools = db.prepare("SELECT tool_name FROM tool_uses WHERE session_id = 'cx-1'").all();
    expect(tools).toContainEqual({ tool_name: "Edit" });

    // By-Source breakdown can now see a non-claude row.
    const sources = db.prepare("SELECT DISTINCT source FROM sessions ORDER BY source").all();
    expect(sources).toContainEqual({ source: "codex" });
    reloaded.conn.closeDb();
  });

  it("skips an unchanged non-Claude file on a second reconcile (no re-parse)", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    const codexFile = await makeCodexFile();
    const adapterSessions: SessionFile[] = [
      { source: "codex", filePath: codexFile, projectDirName: "codexproj" },
    ];
    const parseAdapterFile = vi.fn(async (_f: SessionFile): Promise<UsageTurn[]> => [
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1"),
    ]);
    const opts = { projectsDir, config: cfg(["claude", "codex"]), adapterSessions, parseAdapterFile };

    await reloaded.ingest.reconcileAllSessions(db, opts);
    expect(parseAdapterFile).toHaveBeenCalledTimes(1);
    const second = await reloaded.ingest.reconcileAllSessions(db, opts);
    // mtime/size/derived_version unchanged → skip-gate returns before parsing.
    expect(parseAdapterFile).toHaveBeenCalledTimes(1);
    expect(second.filesChanged).toBe(0);
    reloaded.conn.closeDb();
  });

  it("prunes a non-Claude session when its adapter is disabled (no longer discovered)", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    // Realistic scenario: the user has a Claude tree AND Codex, then disables
    // Codex. The Claude walk must succeed (be enumerable) for the prune pass to
    // run — a transient Claude-walk failure deliberately skips pruning.
    await fs.mkdir(projectsDir, { recursive: true });
    const codexFile = await makeCodexFile();
    const parseAdapterFile = vi.fn(async (_f: SessionFile): Promise<UsageTurn[]> => [
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1"),
    ]);

    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude", "codex"]),
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }],
      parseAdapterFile,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(1);

    // Adapter disabled → empty discovery → pruned.
    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude"]), adapterSessions: [], parseAdapterFile,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(0);
    reloaded.conn.closeDb();
  });

  it("default config (claude only) ingests NO non-Claude rows but still indexes Claude", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    // A real Claude session in the tmp tree.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "claude-1.jsonl"), [
      userTurn("2026-05-01T09:00:00Z", "hi claude"),
      assistantTurn("2026-05-01T09:00:01Z", "claude-sonnet-4-5", "hello"),
    ]);
    // No adapterSessions / parseAdapterFile override: real discovery runs, but
    // ~/.codex and ~/.gemini don't exist under tmpHome and enabledAdapters is
    // claude-only anyway — so the adapter pass is a verified no-op.
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir, config: cfg(["claude"]) });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source<>'claude'").get() as { n: number }).n
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='claude'").get() as { n: number }).n
    ).toBe(1);
    reloaded.conn.closeDb();
  });

  it("ingests adapter sessions even when ~/.claude/projects does not exist (Codex-only user)", async () => {
    const { reloaded } = await setup();
    const db = (await reloaded.conn.getDb())!;
    const codexFile = await makeCodexFile();
    // Point projectsDir at a path that does NOT exist — the Claude walk fails,
    // but that must no longer abort the whole reconcile.
    const missingProjectsDir = path.join(tmpHome, "no-such-claude", "projects");
    const parseAdapterFile = vi.fn(async (_f: SessionFile): Promise<UsageTurn[]> => [
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1"),
    ]);

    const stats = await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir: missingProjectsDir,
      config: cfg(["claude", "codex"]),
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }],
      parseAdapterFile,
    });
    expect(stats.errors).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(1);
    reloaded.conn.closeDb();
  });

  // ── PR #209 review fixes ───────────────────────────────────────────────

  it("replaces a stale row when the adapter resolves a different sessionId for the same file (UNIQUE file_path)", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    const codexFile = await makeCodexFile();
    const sf: SessionFile = { source: "codex", filePath: codexFile, projectDirName: "codexproj" };

    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude", "codex"]), adapterSessions: [sf],
      parseAdapterFile: async () => [uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1")],
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='cx-1'").get() as { n: number }).n
    ).toBe(1);

    // Same file, but the adapter now resolves a DIFFERENT id (e.g. a parser
    // change). `force` bypasses the skip-gate. Must not throw on the
    // UNIQUE(file_path) constraint, and must replace the stale row.
    const stats = await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, force: true, config: cfg(["claude", "codex"]), adapterSessions: [sf],
      parseAdapterFile: async () => [uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-2")],
    });
    expect(stats.errors).toBe(0);
    const rows = db
      .prepare("SELECT session_id FROM sessions WHERE file_path = ?")
      .all(codexFile) as Array<{ session_id: string }>;
    expect(rows).toEqual([{ session_id: "cx-2" }]); // exactly one row, new id wins
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='cx-1'").get() as { n: number }).n
    ).toBe(0);
    reloaded.conn.closeDb();
  });

  it("refreshes stale daily_costs tuples when an adapter file is rewritten with a different model", async () => {
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    await fs.mkdir(projectsDir, { recursive: true });
    const codexFile = await makeCodexFile();
    const sf: SessionFile = { source: "codex", filePath: codexFile, projectDirName: "codexproj" };

    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude", "codex"]), adapterSessions: [sf],
      parseAdapterFile: async () => [uAsst("2026-05-01T10:00:01Z", "gpt-4", "hi", "cx-1")],
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE model='gpt-4'").get() as { n: number }).n
    ).toBe(1);

    // Rewrite the SAME file with a different model. The old (day|project|gpt-4)
    // tuple must be refreshed away, not left stale (mirrors the Claude path's
    // old+new tuple union).
    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, force: true, config: cfg(["claude", "codex"]), adapterSessions: [sf],
      parseAdapterFile: async () => [uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1")],
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE model='gpt-4'").get() as { n: number }).n
    ).toBe(0); // stale tuple recomputed → gone
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM daily_costs WHERE model='gpt-5'").get() as { n: number }).n
    ).toBe(1);
    reloaded.conn.closeDb();
  });

  it("prunes non-Claude rows on adapter-disable even with no Claude tree (Codex-only user)", async () => {
    const { reloaded } = await setup();
    const db = (await reloaded.conn.getDb())!;
    const codexFile = await makeCodexFile();
    const missingProjectsDir = path.join(tmpHome, "no-such-claude", "projects");
    const parseAdapterFile = vi.fn(async (_f: SessionFile): Promise<UsageTurn[]> => [
      uAsst("2026-05-01T10:00:01Z", "gpt-5", "hi", "cx-1"),
    ]);

    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir: missingProjectsDir, config: cfg(["claude", "codex"]),
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }],
      parseAdapterFile,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(1);

    // Disable codex (empty discovery), still no Claude tree. The early-return
    // must NOT fire (existing non-Claude rows present), so the prune runs.
    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir: missingProjectsDir, config: cfg(["claude"]), adapterSessions: [], parseAdapterFile,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(0);
    reloaded.conn.closeDb();
  });

  it("source-filtered byCategory excludes other sources (no rollup source-mixing)", async () => {
    process.env.MINDER_USE_DB = "1";
    const { reloaded, projectsDir } = await setup();
    const db = (await reloaded.conn.getDb())!;
    // One real Claude session...
    await writeJsonl(path.join(projectsDir, "C--dev-app", "claude-1.jsonl"), [
      userTurn("2026-05-01T09:00:00Z", "hi claude"),
      assistantTurn("2026-05-01T09:00:01Z", "claude-sonnet-4-5", "hello"),
    ]);
    // ...and one Codex session, in the same DB.
    const codexFile = await makeCodexFile();
    await reloaded.ingest.reconcileAllSessions(db, {
      projectsDir, config: cfg(["claude", "codex"]),
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }],
      parseAdapterFile: async () => [uAsst("2026-05-01T10:00:01Z", "gpt-5", "do work", "cx-1")],
    });

    const sumTurns = (cats: Array<{ turns: number }>) => cats.reduce((n, c) => n + c.turns, 0);
    const all = (await reloaded.data.getUsage("all", undefined)).report;
    const codex = (await reloaded.data.getUsage("all", undefined, "codex")).report;
    const claude = (await reloaded.data.getUsage("all", undefined, "claude")).report;

    // All-sources byCategory sees both assistant turns; each source filter must
    // see only its own (before the fix, the source-agnostic rollup leaked both
    // into every source filter).
    expect(sumTurns(all.byCategory)).toBe(2);
    expect(sumTurns(codex.byCategory)).toBe(1);
    expect(sumTurns(claude.byCategory)).toBe(1);
    reloaded.conn.closeDb();
  });
});
