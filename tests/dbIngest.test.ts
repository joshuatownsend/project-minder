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
    expect(session.derived_version).toBe(1);

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
});
