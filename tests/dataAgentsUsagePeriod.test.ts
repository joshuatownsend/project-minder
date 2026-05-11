import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Phase 4.1: SQL filter on `loadAgentUsageFromDb` / `loadSkillUsageFromDb`.
// The new `sinceIso` parameter adds `WHERE tu.ts >= ?` to the aggregate
// query. We ingest a fixture spanning ~30 days and assert that the
// returned stats only include invocations at or after the bound.
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
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(timestamp: string, text: string): JsonlEntry {
  return { type: "user", timestamp, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(
  timestamp: string,
  toolName: "Agent" | "Skill",
  invokeArg: Record<string, unknown>,
): JsonlEntry {
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-opus-4-7",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: `tu-${timestamp}`, name: toolName, input: invokeArg },
      ],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

const PROJECT_DIR = "C--dev-app-x";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");

  // Three sessions, each with one Agent + one Skill invocation:
  //   - 35 days ago (out of 30d window)
  //   -  5 days ago (in 30d, in 7d, out of 24h)
  //   -  2 hours ago (relative to NOW used in tests below)
  // Timestamps are fixed strings to keep the test deterministic — the
  // tests then choose sinceIso bounds that include/exclude each.
  await writeJsonl(path.join(projectsDir, PROJECT_DIR, "aaaaaaaa-1111-2222-3333-444455556666.jsonl"), [
    userTurn("2026-04-06T12:00:00Z", "old"),
    assistantTurn("2026-04-06T12:00:01Z", "Agent", { subagent_type: "Explore" }),
    assistantTurn("2026-04-06T12:00:02Z", "Skill", { skill: "test-skill" }),
  ]);
  await writeJsonl(path.join(projectsDir, PROJECT_DIR, "bbbbbbbb-1111-2222-3333-444455556666.jsonl"), [
    userTurn("2026-05-06T12:00:00Z", "mid"),
    assistantTurn("2026-05-06T12:00:01Z", "Agent", { subagent_type: "Explore" }),
    assistantTurn("2026-05-06T12:00:02Z", "Skill", { skill: "test-skill" }),
  ]);
  await writeJsonl(path.join(projectsDir, PROJECT_DIR, "cccccccc-1111-2222-3333-444455556666.jsonl"), [
    userTurn("2026-05-11T10:00:00Z", "fresh"),
    assistantTurn("2026-05-11T10:00:01Z", "Agent", { subagent_type: "Explore" }),
    assistantTurn("2026-05-11T10:00:02Z", "Skill", { skill: "test-skill" }),
  ]);

  return projectsDir;
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    agentLoader: await import("@/lib/data/agentsUsageFromDb"),
    skillLoader: await import("@/lib/data/skillsUsageFromDb"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-period-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MINDER_USE_DB = "1";
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

describe.skipIf(!driverAvailable)("loadAgentUsageFromDb / loadSkillUsageFromDb — sinceIso filter", () => {
  async function setupAndReconcile() {
    const projectsDir = await setupFixture();
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    await mods.ingest.reconcileAllSessions((await mods.conn.getDb())!, { projectsDir });
    return mods;
  }

  it("returns all rows when sinceIso is undefined", async () => {
    const mods = await setupAndReconcile();
    const db = (await mods.conn.getDb())!;
    const stats = mods.agentLoader.loadAgentUsageFromDb(db);
    expect(stats[0]?.invocations).toBe(3);
  });

  it("filters Agent invocations to rows ≥ sinceIso", async () => {
    const mods = await setupAndReconcile();
    const db = (await mods.conn.getDb())!;
    // Exclude the 2026-04-06 row → keep 2 (mid + fresh).
    const stats = mods.agentLoader.loadAgentUsageFromDb(db, "2026-05-01T00:00:00.000Z");
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(2);
  });

  it("filters Skill invocations to rows ≥ sinceIso", async () => {
    const mods = await setupAndReconcile();
    const db = (await mods.conn.getDb())!;
    // Bound at 2026-05-10 → only the fresh row survives.
    const stats = mods.skillLoader.loadSkillUsageFromDb(db, "2026-05-10T00:00:00.000Z");
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(1);
  });

  it("returns an empty list when no row falls inside the window", async () => {
    const mods = await setupAndReconcile();
    const db = (await mods.conn.getDb())!;
    const stats = mods.agentLoader.loadAgentUsageFromDb(db, "2027-01-01T00:00:00.000Z");
    expect(stats).toEqual([]);
  });

  it("inclusive lower bound — row whose ts equals sinceIso is included", async () => {
    const mods = await setupAndReconcile();
    const db = (await mods.conn.getDb())!;
    // 2026-05-06T12:00:01Z is the exact ts of the 'mid' Agent row.
    const stats = mods.agentLoader.loadAgentUsageFromDb(db, "2026-05-06T12:00:01.000Z");
    // 'mid' (1) + 'fresh' (1) = 2
    expect(stats[0]?.invocations).toBe(2);
  });
});
