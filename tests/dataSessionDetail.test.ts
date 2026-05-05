import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Parity test for `getSessionDetail`. Drives the same fixture through
// both backends (file-parse via `scanSessionDetail`, DB via
// `loadSessionDetailFromDb`) and asserts agreement on every field that
// isn't an intentional divergence.
//
// Documented divergences (from header comment in
// `src/lib/data/sessionDetailFromDb.ts`):
// 1. `recaps` undefined in DB path
// 2. `searchableText` undefined in DB path
// 3. `subagents.messageCount` and `toolUsage` zeroed in DB path
// 4. `status` heuristic (working/idle from age) in DB path
// 5. `bash` fileOperations from `tool_uses` not `file_edits`
// 6. No `thinking` events; at most one `assistant` event per turn
// 7. Sidechain entries skipped at ingest
// 8. fileOperations limited to Read/Write/Edit/Glob/Grep + Bash
//
// **Fixture constraint**: every assistant turn in `setupFixture` has at
// most one text block and no `thinking` blocks, no sidechain entries,
// and no MultiEdit/NotebookEdit calls. That keeps the parity assertions
// (`timeline.length`, event-type sequence, `fileOperations` set) true
// despite divergences (6)–(8). Adding a multi-block/thinking/sidechain
// case to the fixture would intentionally break those asserts and
// require relaxing them to "DB events are a subsequence of file events"
// — out of scope until ingest persists content blocks.
//
// Skipped when better-sqlite3 isn't loadable.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalUseDb: string | undefined;

interface JsonlEntry {
  type: "user" | "assistant" | "system";
  timestamp: string;
  message?: any;
  content?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
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
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = []
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
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

const SESSION_ID = "abcdef00-1111-2222-3333-444455556666";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_ID}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "fix the bug in the parser"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Looking at it", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/parser.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Fixing now", [
      { id: "tu_a2", name: "Edit", input: { file_path: "/repo/parser.ts", old_string: "x", new_string: "y" } },
      { id: "tu_a3", name: "Bash", input: { command: "npm test" } },
    ]),
    assistantTurn("2026-04-15T10:00:03Z", "claude-sonnet-4-5", "Dispatching agent", [
      {
        id: "tu_a4",
        name: "Agent",
        input: { subagent_type: "Explore", description: "scope the bug", prompt: "find the bug" },
      },
    ]),
    userTurn("2026-04-15T10:00:30Z", "looks good"),
  ]);
  return projectsDir;
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __sessionIndex?: unknown }).__sessionIndex;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    facade: await import("@/lib/data"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-detail-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalUseDb === undefined) delete process.env.MINDER_USE_DB;
  else process.env.MINDER_USE_DB = originalUseDb;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("data façade — getSessionDetail backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0 and returns a populated SessionDetail", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSessionDetail(SESSION_ID);

    expect(result.meta.backend).toBe("file");
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
    expect(result.detail!.userMessageCount).toBe(2);
    expect(result.detail!.assistantMessageCount).toBe(3);
    // Timeline includes 2 user + 3 assistant text + 4 tool_use blocks = 9 events.
    // (User turns with non-empty text are kept; tool-result-only user turns are skipped.)
    expect(result.detail!.timeline.length).toBeGreaterThanOrEqual(8);
    expect(result.detail!.subagents.length).toBe(1);
    expect(result.detail!.subagents[0].type).toBe("Explore");
    // No .meta.json files in fixture — metaSourced must be false on both paths.
    expect(result.detail!.subagents[0].metaSourced).toBe(false);
  });

  it("falls back to file-parse when the session isn't indexed", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade } = await reloadModules();
    // No reconcile → DB has no rows for this session → DB path returns null
    // → façade falls through to file-parse, which finds the JSONL on disk.
    // The HTTP layer would only return 404 if BOTH backends miss; this test
    // proves the DB miss alone doesn't 404.
    const result = await facade.getSessionDetail(SESSION_ID);
    expect(result.meta.backend).toBe("file");
    expect(result.detail).not.toBeNull();
  });

  it("DB backend serves the same SessionDetail (modulo documented divergences)", async () => {
    const projectsDir = await setupFixture();

    // -- File-parse run --
    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getSessionDetail(SESSION_ID);
    expect(fileResult.meta.backend).toBe("file");
    expect(fileResult.detail).not.toBeNull();

    // -- DB run --
    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
    const dbResult = await dbFacade.getSessionDetail(SESSION_ID);
    expect(dbResult.meta.backend).toBe("db");
    expect(dbResult.detail).not.toBeNull();

    const f = fileResult.detail!;
    const d = dbResult.detail!;

    // Numeric fields must match exactly.
    expect(d.sessionId).toBe(f.sessionId);
    expect(d.projectSlug).toBe(f.projectSlug);
    expect(d.projectName).toBe(f.projectName);
    expect(d.projectPath).toBe(f.projectPath);
    expect(d.startTime).toBe(f.startTime);
    expect(d.endTime).toBe(f.endTime);
    expect(d.durationMs).toBe(f.durationMs);
    expect(d.initialPrompt).toBe(f.initialPrompt);
    // file-parse computes lastPrompt with same suppression logic; both
    // backends suppress when equal to initialPrompt.
    expect(d.lastPrompt).toBe(f.lastPrompt);
    expect(d.messageCount).toBe(f.messageCount);
    expect(d.userMessageCount).toBe(f.userMessageCount);
    expect(d.assistantMessageCount).toBe(f.assistantMessageCount);
    expect(d.inputTokens).toBe(f.inputTokens);
    expect(d.outputTokens).toBe(f.outputTokens);
    expect(d.cacheReadTokens).toBe(f.cacheReadTokens);
    expect(d.cacheCreateTokens).toBe(f.cacheCreateTokens);
    expect(d.costEstimate).toBeCloseTo(f.costEstimate, 6);
    expect(d.errorCount).toBe(f.errorCount);
    expect(d.subagentCount).toBe(f.subagentCount);
    expect(d.modelsUsed.sort()).toEqual([...f.modelsUsed].sort());
    expect(d.toolUsage).toEqual(f.toolUsage);
    expect(d.skillsUsed).toEqual(f.skillsUsed);
    expect(d.gitBranch).toBe(f.gitBranch);
    expect(d.isActive).toBe(f.isActive);

    // Timeline: same length and same event-type sequence.
    expect(d.timeline.length).toBe(f.timeline.length);
    for (let i = 0; i < f.timeline.length; i++) {
      expect(d.timeline[i].type, `timeline[${i}].type`).toBe(f.timeline[i].type);
      expect(d.timeline[i].toolName, `timeline[${i}].toolName`).toBe(f.timeline[i].toolName);
    }

    // File operations: every (path, operation) pair from file-parse must
    // be present in DB output. Order can differ because file-parse
    // emits in JSONL order; DB emits file_edits first then bash entries.
    const fileOpKey = (op: { path: string; operation: string }) => `${op.operation}:${op.path}`;
    const fileSet = new Set(f.fileOperations.map(fileOpKey));
    const dbSet = new Set(d.fileOperations.map(fileOpKey));
    expect(dbSet).toEqual(fileSet);

    // Subagents: count matches; per-agent type/description preserved.
    // messageCount and toolUsage are zeroed in DB path (documented).
    expect(d.subagents.length).toBe(f.subagents.length);
    const fByType = new Map(f.subagents.map((s) => [s.type, s]));
    for (const dSub of d.subagents) {
      const fSub = fByType.get(dSub.type);
      expect(fSub, `subagent type ${dSub.type} missing in file path`).toBeDefined();
      expect(dSub.description).toBe(fSub!.description);
      // No .meta.json files in test fixture — both paths produce same meta fields.
      expect(dSub.metaSourced).toBe(fSub!.metaSourced);
      expect(dSub.category).toBe(fSub!.category);
      // Documented divergence — DB path leaves these zeroed.
      expect(dSub.messageCount).toBe(0);
      expect(dSub.toolUsage).toEqual({});
    }

    // Documented divergences — assert the DB path's intentional differences.
    expect(d.recaps).toBeUndefined();
    expect(d.searchableText).toBeUndefined();
  });

  it("rejects path-traversal-shaped sessionIds", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });

    const result = await facade.getSessionDetail("../../../etc/passwd");
    expect(result.detail).toBeNull();
  });

  // ── Slug + sessionId disambiguation (PR #60 review fix) ────────────────
  //
  // The shape gate must be hex-and-dash, not strict UUID. A non-canonical
  // hex sessionId (anything matching `[a-f0-9-]+` that isn't UUID-shaped)
  // would otherwise route through slug resolution and miss the loader.

  it("DB-resolves a session by its human-readable slug", async () => {
    const SLUG = "shimmering-quokka-prancing";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${SESSION_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      // Slug appears as a top-level field on assistant entries.
      {
        type: "assistant",
        timestamp: "2026-04-15T10:00:01Z",
        slug: SLUG,
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as any,
    ]);
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });

    const result = await facade.getSessionDetail(SLUG);
    expect(result.meta.backend).toBe("db");
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
  });

  it("non-canonical hex sessionIds still hit the DB loader (not slug resolution)", async () => {
    // 32-char hex without UUID dashes — valid for the loader's hex gate
    // but rejected by a strict UUID regex. Pre-PR-60-fix this would have
    // tried slug resolution (miss), then file-parse with the hex string
    // (which would resolve, but via the slow path). The loader must be
    // hit directly.
    const HEX_ID = "abcdef00111122223333444455556666";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${HEX_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "hello", []),
    ]);
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });

    const result = await facade.getSessionDetail(HEX_ID);
    expect(result.meta.backend).toBe("db");
    expect(result.detail!.sessionId).toBe(HEX_ID);
  });
});
