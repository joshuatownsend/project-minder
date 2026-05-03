import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Parity test for `getSkillUsage`. Mirror of `dataAgentsUsage.test.ts`
// against `tool_uses.skill_name`. No documented divergences — both
// backends skip sidechain entries (parser.ts:103 for file-parse,
// ingest for DB) and extract `skill_name` from the same `args.skill`
// field. Skipped when better-sqlite3 isn't loadable.

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

const SESSION_A = "aaaaaaaa-3333-3333-3333-444455556666";
const SESSION_B = "bbbbbbbb-3333-3333-3333-444455556666";
const SESSION_C = "cccccccc-3333-3333-3333-444455556666";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "do task"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-opus-4-7", "Using skills", [
      { id: "tu_a1", name: "Skill", input: { skill: "remember" } },
      { id: "tu_a2", name: "Skill", input: { skill: "remember" } },
    ]),
    assistantTurn("2026-04-15T10:00:05Z", "claude-opus-4-7", "More", [
      { id: "tu_a3", name: "Skill", input: { skill: "remember" } },
      { id: "tu_a4", name: "Skill", input: { skill: "schedule" } },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "more work"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-opus-4-7", "Skill use", [
      { id: "tu_b1", name: "Skill", input: { skill: "remember" } },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_C}.jsonl`), [
    userTurn("2026-04-17T12:00:00Z", "schedule"),
    assistantTurn("2026-04-17T12:00:01Z", "claude-opus-4-7", "Sched", [
      { id: "tu_c1", name: "Skill", input: { skill: "schedule" } },
      { id: "tu_c2", name: "Skill", input: { skill: "schedule" } },
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-skills-"));
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

describe.skipIf(!driverAvailable)("data façade — getSkillUsage backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSkillUsage();

    expect(result.meta.backend).toBe("file");
    expect(result.stats.length).toBe(2);
    // remember = 4 (3 in A + 1 in B), schedule = 3 (1 in A + 2 in C).
    expect(result.stats[0].name).toBe("remember");
    expect(result.stats[0].invocations).toBe(4);
    expect(result.stats[1].name).toBe("schedule");
    expect(result.stats[1].invocations).toBe(3);
  });

  it("falls back to file-parse when no Skill rows are indexed", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    await mig.initDb();
    const result = await facade.getSkillUsage();
    expect(result.meta.backend).toBe("file");
    expect(result.stats.length).toBe(2);
  });

  it("DB backend serves the same SkillStats list (full parity)", async () => {
    const projectsDir = await setupFixture();

    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getSkillUsage();
    expect(fileResult.meta.backend).toBe("file");

    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
    const dbResult = await dbFacade.getSkillUsage();
    expect(dbResult.meta.backend).toBe("db");

    expect(dbResult.stats.length).toBe(fileResult.stats.length);
    expect(dbResult.stats.map((s) => s.name)).toEqual(fileResult.stats.map((s) => s.name));

    const fileByName = new Map(fileResult.stats.map((s) => [s.name, s]));
    for (const d of dbResult.stats) {
      const f = fileByName.get(d.name)!;
      expect(f, `file-parse missing skill ${d.name}`).toBeDefined();
      expect(d.invocations).toBe(f.invocations);
      expect(d.firstUsed).toBe(f.firstUsed);
      expect(d.lastUsed).toBe(f.lastUsed);
      expect(d.projects).toEqual(f.projects);
      expect(d.sessions).toEqual(f.sessions);
    }
  });

  it("returns empty list cleanly on empty corpus", async () => {
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSkillUsage();
    expect(result.stats).toEqual([]);
    expect(result.meta.backend).toBe("file");
  });
});
