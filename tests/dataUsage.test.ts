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

    // Per-dimension value parity (not just name sets). For each
    // breakdown list, build a map keyed on the dimension's identifier
    // and assert every numeric field agrees within float tolerance.
    // Without this the parity test would pass even if backends produced
    // different costs per project / model / category — exactly the kind
    // of silent drift the per-backend ETag salt is currently hedging
    // against.
    const fileProjects = new Map(file.byProject.map((p) => [p.projectSlug, p]));
    for (const dbProj of db.byProject) {
      const fileProj = fileProjects.get(dbProj.projectSlug);
      expect(fileProj, `project ${dbProj.projectSlug} missing in file backend`).toBeDefined();
      expect(dbProj.cost).toBeCloseTo(fileProj!.cost, 6);
      expect(dbProj.tokens).toBe(fileProj!.tokens);
      expect(dbProj.turns).toBe(fileProj!.turns);
    }

    const fileModels = new Map(file.byModel.map((m) => [m.model, m]));
    for (const dbModel of db.byModel) {
      const fileModel = fileModels.get(dbModel.model);
      expect(fileModel, `model ${dbModel.model} missing in file backend`).toBeDefined();
      expect(dbModel.cost).toBeCloseTo(fileModel!.cost, 6);
      expect(dbModel.inputTokens).toBe(fileModel!.inputTokens);
      expect(dbModel.outputTokens).toBe(fileModel!.outputTokens);
      expect(dbModel.turns).toBe(fileModel!.turns);
    }

    const fileCategories = new Map(file.byCategory.map((c) => [c.category, c]));
    for (const dbCat of db.byCategory) {
      const fileCat = fileCategories.get(dbCat.category);
      expect(fileCat, `category ${dbCat.category} missing in file backend`).toBeDefined();
      expect(dbCat.turns).toBe(fileCat!.turns);
      expect(dbCat.tokens).toBe(fileCat!.tokens);
      expect(dbCat.cost).toBeCloseTo(fileCat!.cost, 6);
    }

    // Top-tool counts should match by name.
    const fileTools = new Map(file.topTools);
    for (const [name, count] of db.topTools) {
      expect(fileTools.get(name), `tool ${name} missing in file backend`).toBe(count);
    }

    // Daily buckets: same set of dates, same numbers per date.
    const fileDaily = new Map(file.daily.map((d) => [d.date, d]));
    expect(db.daily.length).toBe(file.daily.length);
    for (const dbDay of db.daily) {
      const fileDay = fileDaily.get(dbDay.date);
      expect(fileDay, `date ${dbDay.date} missing in file backend`).toBeDefined();
      expect(dbDay.cost).toBeCloseTo(fileDay!.cost, 6);
      expect(dbDay.inputTokens).toBe(fileDay!.inputTokens);
      expect(dbDay.outputTokens).toBe(fileDay!.outputTokens);
      expect(dbDay.turns).toBe(fileDay!.turns);
    }

    // MCP stats: same servers, same totalCalls. Tools mix may differ in
    // tie-breaking order but counts per (server, tool) must match.
    const fileMcp = new Map(file.mcpStats.map((m) => [m.server, m]));
    expect(db.mcpStats.length).toBe(file.mcpStats.length);
    for (const dbMcp of db.mcpStats) {
      const fileEntry = fileMcp.get(dbMcp.server);
      expect(fileEntry, `mcp server ${dbMcp.server} missing in file backend`).toBeDefined();
      expect(dbMcp.totalCalls).toBe(fileEntry!.totalCalls);
      for (const [tool, count] of Object.entries(dbMcp.tools)) {
        expect(fileEntry!.tools[tool], `mcp tool ${dbMcp.server}/${tool} mismatch`).toBe(count);
      }
    }

    // Shell binary counts: same set of binaries, same counts.
    const fileShell = new Map(file.shellStats.map((s) => [s.binary, s.count]));
    expect(db.shellStats.length).toBe(file.shellStats.length);
    for (const dbShell of db.shellStats) {
      expect(fileShell.get(dbShell.binary), `shell binary ${dbShell.binary} mismatch`).toBe(
        dbShell.count
      );
    }

    // One-shot aggregates. period=all has no boundary divergence between
    // backends — both compute over the whole corpus.
    expect(db.oneShot.totalVerifiedTasks).toBe(file.oneShot.totalVerifiedTasks);
    expect(db.oneShot.oneShotTasks).toBe(file.oneShot.oneShotTasks);
    expect(db.oneShot.rate).toBeCloseTo(file.oneShot.rate, 6);
  });

  it("DB backend falls back to file when meta.needs_reconcile_after_v3 is set", async () => {
    const projectsDir = await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });

    // Reconcile clears the v3 readiness flag on success — re-set it to
    // simulate a process that's been restarted between migration apply
    // and a clean reconcile run.
    const db = (await conn.getDb())!;
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('needs_reconcile_after_v3', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();

    const result = await facade.getUsage("all", undefined);
    expect(result.meta.backend).toBe("file");
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
