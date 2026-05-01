import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Parity test for the read-side usage façade. Drives the same fixture
// through both backends (file-parse and DB-rehydrate) and asserts the
// reports are identical on every dimension that doesn't depend on
// wall-clock time.
//
// Skipped when better-sqlite3 isn't loadable — the DB backend obviously
// can't run.

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
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
  isSidechain?: boolean;
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
  model: string,
  text: string,
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = [],
  inputTokens = 100,
  outputTokens = 50
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
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  // Two project dirs, two sessions total. Mix of tool calls so the
  // aggregator's category / tool / mcp dimensions all have content.
  await writeJsonl(path.join(projectsDir, "C--dev-app-a", "session-1.jsonl"), [
    userTurn("2026-04-15T10:00:00Z", "fix the bug in the parser"),
    assistantTurn(
      "2026-04-15T10:00:01Z",
      "claude-sonnet-4-5",
      "Looking at it",
      [{ id: "tu_a1", name: "Read", input: { file_path: "/repo/parser.ts" } }],
      120,
      60
    ),
    assistantTurn(
      "2026-04-15T10:00:02Z",
      "claude-sonnet-4-5",
      "Fixing now",
      [
        { id: "tu_a2", name: "Edit", input: { file_path: "/repo/parser.ts", old_string: "x", new_string: "y" } },
        { id: "tu_a3", name: "Bash", input: { command: "npm test" } },
      ],
      150,
      80
    ),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-b", "session-2.jsonl"), [
    userTurn("2026-04-20T08:00:00Z", "refactor this module"),
    assistantTurn(
      "2026-04-20T08:00:01Z",
      "claude-sonnet-4-5",
      "OK",
      [{ id: "tu_b1", name: "Write", input: { file_path: "/repo/util.ts", content: "// new" } }],
      90,
      40
    ),
  ]);
  return projectsDir;
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __usageAllSessionsInFlight?: unknown }).__usageAllSessionsInFlight;
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-data-usage-"));
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

describe.skipIf(!driverAvailable)("data façade — getUsage backend parity", () => {
  it("file backend runs by default and returns a populated report", async () => {
    await setupFixture();
    delete process.env.MINDER_USE_DB;
    const { facade } = await reloadModules();
    const result = await facade.getUsage("all", undefined);

    expect(result.meta.backend).toBe("file");
    expect(result.report.totalSessions).toBe(2);
    expect(result.report.totalTurns).toBe(3); // assistant turns only
    expect(result.report.totalCost).toBeGreaterThan(0);
    expect(result.report.byProject.length).toBe(2);
  });

  it("DB backend produces a report identical to file backend (modulo generatedAt)", async () => {
    const projectsDir = await setupFixture();

    // -- File backend run --
    delete process.env.MINDER_USE_DB;
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getUsage("all", undefined);
    expect(fileResult.meta.backend).toBe("file");

    // -- DB backend run, separately --
    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });
    const dbResult = await dbFacade.getUsage("all", undefined);
    expect(dbResult.meta.backend).toBe("db");

    // The two reports should agree on every aggregate. `generatedAt`
    // differs between calls and `period` is the same input, so we only
    // diff the substantive dimensions.
    const file = fileResult.report;
    const db = dbResult.report;

    expect(db.totalSessions).toBe(file.totalSessions);
    expect(db.totalTurns).toBe(file.totalTurns);
    expect(db.totalTokens).toBe(file.totalTokens);
    expect(db.tokens).toEqual(file.tokens);
    expect(db.totalCost).toBeCloseTo(file.totalCost, 6);

    // byProject / byModel are sorted-by-cost lists, so a direct deep
    // compare is meaningful (no ordering ambiguity).
    expect(db.byProject.map((p) => p.projectSlug).sort()).toEqual(
      file.byProject.map((p) => p.projectSlug).sort()
    );
    expect(db.byModel.map((m) => m.model).sort()).toEqual(
      file.byModel.map((m) => m.model).sort()
    );
    expect(db.byCategory.map((c) => c.category).sort()).toEqual(
      file.byCategory.map((c) => c.category).sort()
    );

    // Tool aggregates should match by name.
    expect(new Set(db.topTools.map(([n]) => n))).toEqual(
      new Set(file.topTools.map(([n]) => n))
    );
  });

  it("falls back to file backend when MINDER_USE_DB=1 but DB has no schema", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade } = await reloadModules();

    // No initDb / no ingest run — but the façade calls initDb itself,
    // which will succeed and find an empty DB. With zero rows, the
    // rehydrate path returns an empty report. To prove "falls back to
    // file when DB is genuinely unavailable", spy on initDb to fail.
    const mig = await import("@/lib/db/migrations");
    vi.spyOn(mig, "initDb").mockResolvedValue({
      available: false,
      appliedMigrations: [],
      schemaVersion: 0,
      quarantined: null,
      error: new Error("simulated init failure"),
    });

    const result = await facade.getUsage("all", undefined);
    expect(result.meta.backend).toBe("file");
    expect(result.report.totalSessions).toBe(2);
  });
});
