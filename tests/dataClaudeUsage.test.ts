import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Parity test for `getClaudeUsage`. Drives the same fixture through
// both backends (file-parse via `scanClaudeConversationsForProjects`,
// DB via `loadClaudeUsageStatsFromDb`) and asserts agreement on every
// numeric field except `costEstimate` — which is documented as more
// accurate under DB mode (file-parse buckets cache-only files as
// "unknown" → sonnet-fallback pricing; DB knows the actual model).
//
// **Fixture constraint**: assistant turns specify a real model and
// have non-zero token usage so per-model cost calculation has data
// to chew on. No sidechain entries.
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
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    },
  };
}

const SESSION_A = "aaaaaaaa-4444-4444-4444-444455556666";
const SESSION_B = "bbbbbbbb-4444-4444-4444-444455556666";

async function setupFixture(): Promise<{ projectsDir: string; projectPaths: string[] }> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "do task"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Reading", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/x.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Editing", [
      { id: "tu_a2", name: "Edit", input: { file_path: "/repo/x.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "another"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-sonnet-4-5", "Bash", [
      { id: "tu_b1", name: "Bash", input: { command: "npm test" } },
    ]),
  ]);
  // Use the decoded form because `encodePath` will re-encode it inside
  // both backends — exactly mirroring the production /api/stats call shape.
  return {
    projectsDir,
    projectPaths: ["C:\\dev\\app-x", "C:\\dev\\app-y"],
  };
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __sessionIndex?: unknown }).__sessionIndex;
  delete (globalThis as { __sessionsCache?: unknown }).__sessionsCache;
  delete (globalThis as { __claudeUsageCache?: unknown }).__claudeUsageCache;
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-claude-"));
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

describe.skipIf(!driverAvailable)("data façade — getClaudeUsage backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0", async () => {
    const { projectPaths } = await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getClaudeUsage(projectPaths);

    expect(result.meta.backend).toBe("file");
    expect(result.stats.conversationCount).toBe(2);
    expect(result.stats.totalTurns).toBeGreaterThan(0);
    expect(result.stats.modelsUsed).toContain("claude-sonnet-4-5");
  });

  it("falls back to file-parse when no matching sessions are indexed", async () => {
    const { projectPaths } = await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    await mig.initDb();
    const result = await facade.getClaudeUsage(projectPaths);
    // Empty index → fall through to file-parse; both projects are on disk.
    expect(result.meta.backend).toBe("file");
    expect(result.stats.conversationCount).toBe(2);
  });

  it("DB backend serves the same ClaudeUsageStats (modulo costEstimate accuracy)", async () => {
    const { projectsDir, projectPaths } = await setupFixture();

    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getClaudeUsage(projectPaths);
    expect(fileResult.meta.backend).toBe("file");

    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
    const dbResult = await dbFacade.getClaudeUsage(projectPaths);
    expect(dbResult.meta.backend).toBe("db");

    const f = fileResult.stats;
    const d = dbResult.stats;

    expect(d.conversationCount).toBe(f.conversationCount);
    expect(d.totalTurns).toBe(f.totalTurns);
    expect(d.inputTokens).toBe(f.inputTokens);
    expect(d.outputTokens).toBe(f.outputTokens);
    expect(d.cacheCreateTokens).toBe(f.cacheCreateTokens);
    expect(d.cacheReadTokens).toBe(f.cacheReadTokens);
    expect(d.totalTokens).toBe(f.totalTokens);
    expect(d.errorCount).toBe(f.errorCount);
    expect(d.toolUsage).toEqual(f.toolUsage);
    expect(d.modelsUsed.sort()).toEqual([...f.modelsUsed].sort());

    // costEstimate: documented divergence — DB more accurate. Both
    // backends should still agree to ~4 decimal places (toBeCloseTo's
    // precision arg) on this fixture because every assistant turn
    // carries an explicit canonical model name (`claude-sonnet-4-5`),
    // so file-parse never falls into its sonnet-fallback branch for
    // cache-only rows. The divergence only kicks in for corpora with
    // non-sonnet models on cache-hit files, which the fixture avoids.
    expect(d.costEstimate).toBeGreaterThan(0);
    expect(d.costEstimate).toBeCloseTo(f.costEstimate, 4);
  });

  it("returns empty stats cleanly when projectPaths is empty", async () => {
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getClaudeUsage([]);
    expect(result.stats.conversationCount).toBe(0);
    expect(result.stats.totalTokens).toBe(0);
    expect(result.meta.backend).toBe("file");
  });
});
