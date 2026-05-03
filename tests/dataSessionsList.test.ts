import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

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
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __sessionIndex?: unknown }).__sessionIndex;
  delete (globalThis as { __sessionsCache?: unknown }).__sessionsCache;
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-list-"));
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
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
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

      // Documented divergences — assert the DB path's intentional differences.
      expect(d.recaps).toBeUndefined();
      expect(d.status === "working" || d.status === "idle").toBe(true);

      // searchableText restored as of P2c — should be present on both
      // backends. We don't assert string equality (the file-parse path
      // appends slightly differently from the per-turn DB path; see
      // sessionsListFromDb.ts header divergence #2 quirk), but the DB
      // value should contain the user prompt and at least the prefix
      // of one assistant text. Empty string is the only failure case.
      expect(typeof d.searchableText).toBe("string");
      expect(d.searchableText!.length).toBeGreaterThan(0);
      expect(typeof f.searchableText).toBe("string");
      // Both should include the initial prompt text.
      if (f.initialPrompt) {
        expect(d.searchableText).toContain(f.initialPrompt);
        expect(f.searchableText).toContain(f.initialPrompt);
      }
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
});
