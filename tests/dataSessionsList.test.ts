import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// Parity test for `getSessionsList`. Drives the same fixture through
// both backends (file-parse via `scanAllSessions`, DB via
// `loadSessionsListFromDb`) and asserts agreement on every field that
// isn't an intentional divergence.
//
// Documented divergences (from header comment in
// `src/lib/data/sessionsListFromDb.ts`):
// 1. `recaps` undefined in DB path
// 2. `searchableText` undefined in DB path
// 3. `status` heuristic-only (working/idle from age) in DB path
// 4. Sidechain entries skipped at ingest
// 5. `oneShotRate` from session-row counts
// 6. `costEstimate` from pre-computed `sessions.cost_usd`
// 7. `isActive` matches both
//
// **Fixture constraint**: every assistant turn in `setupFixture` has at
// most one text block, no `thinking` blocks, no sidechain entries. Same
// constraint as `dataSessionDetail.test.ts` — keeps numeric equality
// strict despite divergence #4.
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

const state = installIsolatedState({ prefix: "pm-data-list-", extraGlobals: ["__usageCache", "__usageFileCache", "__sessionIndex", "__sessionsCache"], preserveEnv: ["MINDER_USE_DB"] });

/** Mirror of the helper's temp home, so fixture paths below read unchanged. */
let tmpHome: string;

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

const SESSION_A = "aaaaaaaa-1111-2222-3333-444455556666";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444455556666";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  // Two projects, one session each. Times are spaced so the sort order is
  // unambiguous: session A is older, session B is newer.
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "fix the bug in the parser"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Looking at it", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/parser.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Fixing now", [
      { id: "tu_a2", name: "Edit", input: { file_path: "/repo/parser.ts", old_string: "x", new_string: "y" } },
      { id: "tu_a3", name: "Bash", input: { command: "npm test" } },
    ]),
    userTurn("2026-04-15T10:00:30Z", "looks good"),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "add a new feature"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-opus-4-7", "Designing the feature", [
      { id: "tu_b1", name: "Glob", input: { pattern: "**/*.ts" } },
    ]),
    assistantTurn("2026-04-16T11:00:02Z", "claude-opus-4-7", "Dispatching agent", [
      {
        id: "tu_b2",
        name: "Agent",
        input: { subagent_type: "Explore", description: "scope it", prompt: "find the entrypoint" },
      },
    ]),
  ]);
  return projectsDir;
}

async function reloadModules() {
  await state.reload();
  return {
    facade: await import("@/lib/data"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("data façade — getSessionsList backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSessionsList();

    expect(result.meta.backend).toBe("file");
    expect(result.sessions.length).toBe(2);
    // Sort: most-recent endTime first.
    expect(result.sessions[0].sessionId).toBe(SESSION_B);
    expect(result.sessions[1].sessionId).toBe(SESSION_A);
  });

  it("falls back to file-parse when the index is empty", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    await mig.initDb();
    // No reconcile → DB has zero session rows → façade falls through to
    // file-parse rather than returning an empty list. This is the
    // brand-new-install case where the indexer is still warming up.
    const result = await facade.getSessionsList();
    expect(result.meta.backend).toBe("file");
    expect(result.sessions.length).toBe(2);
  });

  it("DB backend serves the same SessionSummary list (modulo documented divergences)", async () => {
    const projectsDir = await setupFixture();

    // -- File-parse run --
    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getSessionsList();
    expect(fileResult.meta.backend).toBe("file");
    expect(fileResult.sessions.length).toBe(2);

    // -- DB run --
    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );
    const dbResult = await dbFacade.getSessionsList();
    expect(dbResult.meta.backend).toBe("db");
    expect(dbResult.sessions.length).toBe(2);

    // Both backends must agree on sort order (end_ts DESC).
    expect(dbResult.sessions.map((s) => s.sessionId)).toEqual(
      fileResult.sessions.map((s) => s.sessionId)
    );

    const fileById = new Map(fileResult.sessions.map((s) => [s.sessionId, s]));
    for (const d of dbResult.sessions) {
      const f = fileById.get(d.sessionId)!;
      expect(f, `file-parse missing session ${d.sessionId}`).toBeDefined();

      // Numeric / scalar fields must match exactly.
      expect(d.projectSlug).toBe(f.projectSlug);
      expect(d.projectName).toBe(f.projectName);
      expect(d.projectPath).toBe(f.projectPath);
      expect(d.startTime).toBe(f.startTime);
      expect(d.endTime).toBe(f.endTime);
      expect(d.durationMs).toBe(f.durationMs);
      expect(d.initialPrompt).toBe(f.initialPrompt);
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
      expect(d.source).toBe(f.source ?? "claude");

      // Documented divergences — assert the DB path's intentional differences.
      expect(d.recaps).toBeUndefined();
      // status: P2c populates sessions.status at ingest, so the loader
      // can return needs_attention in addition to working/idle. Both
      // backends should agree on the verdict for fixture sessions —
      // our fixture has clean end_turn-style assistants with no
      // dangling tool_uses, so both should return 'idle'.
      expect(d.status).toBe(f.status);

      // searchableText: never on the list from either backend (#700). The
      // index doesn't build it; the file parse does, for the server's search
      // fallback, and `getSessionsList` strips it.
      expect(d.searchableText).toBeUndefined();
      expect(f.searchableText).toBeUndefined();
    }
  });

  it("returns empty list cleanly on empty corpus", async () => {
    // No JSONL files at all.
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSessionsList();
    expect(result.sessions).toEqual([]);
    expect(result.meta.backend).toBe("file");
  });

  it("DB loader detects worktree sessions via file_path (issue #172)", async () => {
    // Regression cover: `canonicalizeDirName` strips the
    // `--claude-worktrees-*` suffix from `project_dir_name` at ingest
    // (to group worktree sessions under the parent project's slug), so
    // both DB loaders must derive `isWorktree` from the raw `file_path`
    // column. Before the fix, this returned `false` for worktree
    // sessions in DB mode while file-parse returned `true`.
    const SESSION_WT = "cccccccc-1111-2222-3333-444455556666";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const worktreeDir = "C--dev-app-x--claude-worktrees-feature";
    await writeJsonl(path.join(projectsDir, worktreeDir, `${SESSION_WT}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "hello", []),
    ]);

    // File backend agreement check.
    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getSessionsList();
    const fileWt = fileResult.sessions.find((s) => s.sessionId === SESSION_WT)!;
    expect(fileWt.isWorktree).toBe(true);

    // DB backend must agree after reconcile.
    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );
    const dbResult = await dbFacade.getSessionsList();
    expect(dbResult.meta.backend).toBe("db");
    const dbWt = dbResult.sessions.find((s) => s.sessionId === SESSION_WT)!;
    expect(dbWt).toBeDefined();
    expect(dbWt.isWorktree).toBe(true);
  });
});

describe.skipIf(!driverAvailable)("loadSessionsListFromDb — reuse until the index changes (#689)", () => {
  async function seeded() {
    const projectsDir = await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { conn, mig, ingest } = await reloadModules();
    expect((await mig.initDb()).available).toBe(true);
    const db = (await conn.getDb())!;
    assertReconcileClean(await ingest.reconcileAllSessions(db, { projectsDir, recordRun: "reconcile" }));
    const list = await import("@/lib/data/sessionsListFromDb");
    return { conn, db, list };
  }

  it("rebuilds only after a write, from this connection or another one", async () => {
    const { conn, db, list } = await seeded();
    const first = list.loadSessionsListFromDb(db);
    expect(first.length).toBe(2);

    const prep = vi.spyOn(conn, "prepCached");
    const again = list.loadSessionsListFromDb(db);
    expect(again).toEqual(first);
    // Only the change-key query ran; none of the build's whole-table queries.
    expect(prep).toHaveBeenCalledTimes(1);
    prep.mockClear();

    // A write on this connection (e.g. starring) moves total_changes().
    db.prepare("UPDATE sessions SET starred_at = ? WHERE session_id = ?").run("2026-10-16T00:00:00Z", SESSION_A);
    const afterOwnWrite = list.loadSessionsListFromDb(db);
    expect(prep.mock.calls.length).toBeGreaterThan(1);
    expect(afterOwnWrite.find((s) => s.sessionId === SESSION_A)?.starredAt).toBe("2026-10-16T00:00:00Z");

    // A commit on another connection (the ingest worker) moves data_version.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const other = new Database(conn.DB_PATH);
    try {
      other.prepare("UPDATE sessions SET starred_at = NULL WHERE session_id = ?").run(SESSION_A);
    } finally {
      other.close();
    }
    const afterWorkerWrite = list.loadSessionsListFromDb(db);
    expect(afterWorkerWrite.find((s) => s.sessionId === SESSION_A)?.starredAt).toBeUndefined();
  });

  it("never reads turn text to build the list (#700)", async () => {
    const { conn, db, list } = await seeded();
    const prep = vi.spyOn(conn, "prepCached");
    const sessions = list.loadSessionsListFromDb(db);
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.searchableText).toBeUndefined();
    const readText = prep.mock.calls.some(([, sql]) => /text_preview/.test(sql));
    expect(readText).toBe(false);
  });

  it("clips the prompts it lists (#704)", async () => {
    const { db, list } = await seeded();
    const { LIST_PROMPT_CHARS } = await import("@/lib/data/sessionsListPayload");
    const long = "p".repeat(LIST_PROMPT_CHARS + 20);
    db.prepare("UPDATE sessions SET initial_prompt = ? WHERE session_id = ?").run(long, SESSION_A);
    const a = list.loadSessionsListFromDb(db).find((s) => s.sessionId === SESSION_A)!;
    expect(a.initialPrompt).toBe(`${"p".repeat(LIST_PROMPT_CHARS)}…`);
  });

  it("keeps a last prompt that differs from the first only past the cut (Codex, PR #709)", async () => {
    const { db, list } = await seeded();
    const { LIST_PROMPT_CHARS } = await import("@/lib/data/sessionsListPayload");
    const head = "p".repeat(LIST_PROMPT_CHARS + 5);
    db.prepare("UPDATE sessions SET initial_prompt = ?, last_prompt = ? WHERE session_id = ?")
      .run(`${head} first`, `${head} last`, SESSION_A);
    const a = list.loadSessionsListFromDb(db).find((s) => s.sessionId === SESSION_A)!;
    expect(a.lastPrompt).toBe(`${"p".repeat(LIST_PROMPT_CHARS)}…`);
  });

  it("recomputes isActive and status on a reused list, and keeps the memo private", async () => {
    const { db, list } = await seeded();
    const row = db.prepare("SELECT file_mtime_ms AS m FROM sessions WHERE session_id = ?").get(SESSION_B) as { m: number };
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(row.m + 30_000);
      const fresh = list.loadSessionsListFromDb(db).find((s) => s.sessionId === SESSION_B)!;
      expect(fresh.isActive).toBe(true);
      fresh.starredAt = "edited by a caller";

      now.mockReturnValue(row.m + 10 * 60_000);
      const later = list.loadSessionsListFromDb(db).find((s) => s.sessionId === SESSION_B)!;
      expect(later.isActive).toBe(false);
      expect(later.starredAt).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
});
