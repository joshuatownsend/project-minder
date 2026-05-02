import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Parity test for `getAgentUsage`. Drives the same fixture through
// both backends (file-parse via `parseAllSessions` + `groupAgentCalls`,
// DB via `loadAgentUsageFromDb`) and asserts agreement on every field.
//
// Unlike P2b-5 (sessions list), there are NO documented divergences
// here — the agent stats derive from indexed `tool_uses.agent_name`
// which is extracted at ingest from the same `args.subagent_type` that
// `groupAgentCalls` reads. Both backends skip sidechain entries
// (parser.ts:103 for file-parse, ingest for DB).
//
// **Fixture constraint**: every assistant turn has at most one text
// block, no thinking, no sidechain. Same constraint as the other
// data-façade tests for shared assertion strictness.
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

const SESSION_A = "aaaaaaaa-2222-2222-3333-444455556666";
const SESSION_B = "bbbbbbbb-2222-2222-3333-444455556666";
const SESSION_C = "cccccccc-2222-2222-3333-444455556666";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  // Project X: two sessions, one dispatching Explore (3 times) and another Plan (1).
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "investigate"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-opus-4-7", "Dispatching", [
      { id: "tu_a1", name: "Agent", input: { subagent_type: "Explore", description: "find X", prompt: "look around" } },
      { id: "tu_a2", name: "Agent", input: { subagent_type: "Explore", description: "find Y", prompt: "look more" } },
    ]),
    assistantTurn("2026-04-15T10:00:05Z", "claude-opus-4-7", "Another dispatch", [
      { id: "tu_a3", name: "Agent", input: { subagent_type: "Explore", description: "find Z", prompt: "again" } },
      { id: "tu_a4", name: "Agent", input: { subagent_type: "Plan", description: "design", prompt: "design it" } },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "another task"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-opus-4-7", "Dispatch Explore", [
      { id: "tu_b1", name: "Agent", input: { subagent_type: "Explore", description: "x", prompt: "p" } },
    ]),
  ]);
  // Project Y: one session dispatching Plan only.
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_C}.jsonl`), [
    userTurn("2026-04-17T12:00:00Z", "plan something"),
    assistantTurn("2026-04-17T12:00:01Z", "claude-opus-4-7", "Plan", [
      { id: "tu_c1", name: "Agent", input: { subagent_type: "Plan", description: "p", prompt: "p" } },
      { id: "tu_c2", name: "Agent", input: { subagent_type: "Plan", description: "p2", prompt: "p2" } },
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-agents-"));
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

describe.skipIf(!driverAvailable)("data façade — getAgentUsage backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getAgentUsage();

    expect(result.meta.backend).toBe("file");
    expect(result.stats.length).toBe(2);
    // Sort: most invocations first. Explore = 4 (3 in A + 1 in B), Plan = 3 (1 in A + 2 in C).
    expect(result.stats[0].name).toBe("Explore");
    expect(result.stats[0].invocations).toBe(4);
    expect(result.stats[1].name).toBe("Plan");
    expect(result.stats[1].invocations).toBe(3);
  });

  it("falls back to file-parse when no Agent rows are indexed", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    await mig.initDb();
    // No reconcile → DB has zero Agent rows → façade falls through to
    // file-parse rather than returning an empty list.
    const result = await facade.getAgentUsage();
    expect(result.meta.backend).toBe("file");
    expect(result.stats.length).toBe(2);
  });

  it("DB backend serves the same AgentStats list (full parity)", async () => {
    const projectsDir = await setupFixture();

    // -- File-parse run --
    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getAgentUsage();
    expect(fileResult.meta.backend).toBe("file");

    // -- DB run --
    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
    const dbResult = await dbFacade.getAgentUsage();
    expect(dbResult.meta.backend).toBe("db");

    // Same shape: same agents, same sort order, same per-field values.
    expect(dbResult.stats.length).toBe(fileResult.stats.length);
    expect(dbResult.stats.map((s) => s.name)).toEqual(fileResult.stats.map((s) => s.name));

    const fileByName = new Map(fileResult.stats.map((s) => [s.name, s]));
    for (const d of dbResult.stats) {
      const f = fileByName.get(d.name)!;
      expect(f, `file-parse missing agent ${d.name}`).toBeDefined();
      expect(d.invocations).toBe(f.invocations);
      expect(d.firstUsed).toBe(f.firstUsed);
      expect(d.lastUsed).toBe(f.lastUsed);
      expect(d.projects).toEqual(f.projects);
      // sessions are top-50 by latest ts DESC; both backends should pick
      // the same set in the same order.
      expect(d.sessions).toEqual(f.sessions);
    }
  });

  it("returns empty list cleanly on empty corpus", async () => {
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getAgentUsage();
    expect(result.stats).toEqual([]);
    expect(result.meta.backend).toBe("file");
  });
});
