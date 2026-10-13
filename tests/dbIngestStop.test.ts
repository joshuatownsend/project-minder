import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #677 — a full reconcile pass stops between files when its caller is shutting down.
//
// Shutdown gives the ingest worker 2 s to exit; a full pass walks ~15k files in 6-18 s and used
// to run to the end first, so the worker was terminated, the clean-shutdown marker was withheld,
// and the next boot paid a ~100 s quick_check. What makes stopping SAFE is the other half
// asserted here: a stopped pass never reaches the prune, which deletes every row it did not see.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-ingest-stop-test-", preserveEnv: ["MINDER_USE_DB"] });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function setup() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  const runs = await import("@/lib/db/indexerRuns");
  expect((await mig.initDb()).error).toBeNull();
  const db = (await conn.getDb())!;
  return { conn, ingest, runs, db, projectsDir: path.join(tmpHome, ".claude", "projects") };
}

/** One minimal session file: a prompt and a reply. */
async function writeSession(projectsDir: string, project: string, id: string): Promise<void> {
  const file = path.join(projectsDir, project, `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-10-12T10:00:00Z", message: { content: [{ type: "text", text: `prompt ${id}` }] } },
    {
      type: "assistant",
      timestamp: "2026-10-12T10:00:01Z",
      message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// By name: each test reloads its modules, so the class it would compare against is a different copy.
const STOPPED = { name: "ReconcileStoppedError" };

const sessionCount = (db: import("better-sqlite3").Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

describe.skipIf(!driverAvailable)("reconcileAllSessions shouldStop (#677)", () => {
  it("stops partway through the walk and throws ReconcileStoppedError", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      for (let i = 0; i < 6; i++) await writeSession(projectsDir, i < 3 ? "C--dev-a" : "C--dev-b", `s${i}`);
      // Stop once two files have been written, whatever order the directories list in.
      const pass = ingest.reconcileAllSessions(db, { projectsDir, shouldStop: () => sessionCount(db) >= 2 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(sessionCount(db)).toBe(2);
    } finally {
      conn.closeDb();
    }
  });

  it("never prunes after a stop, so sessions the walk had not reached yet survive", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      for (let i = 0; i < 4; i++) await writeSession(projectsDir, "C--dev-a", `s${i}`);
      await ingest.reconcileAllSessions(db, { projectsDir });
      expect(sessionCount(db)).toBe(4);

      // Stop at the first check after the pass has started, before the walk has seen any file.
      // A pass that returned early instead of throwing would go on to prune every row it never saw.
      let calls = 0;
      const pass = ingest.reconcileAllSessions(db, { projectsDir, shouldStop: () => ++calls > 1 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(sessionCount(db)).toBe(4);
    } finally {
      conn.closeDb();
    }
  });

  it("records a stopped initial pass as not read through, so the index does not claim to be ready", async () => {
    const { conn, ingest, runs, db, projectsDir } = await setup();
    try {
      await writeSession(projectsDir, "C--dev-a", "s0");
      const pass = ingest.reconcileAllSessions(db, { projectsDir, recordRun: "reconcile", shouldStop: () => true });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(runs.getIndexBuildState(db)).toBe("building");
      // Labelled as a stop, not a failure: this row is read when diagnosing a slow or broken boot.
      expect(db.prepare("SELECT error FROM indexer_runs").get()).toEqual({ error: "reconcile stopped" });
    } finally {
      conn.closeDb();
    }
  });

  it("leaves the last completeness verdict standing, so a quit does not raise 'corpus incomplete'", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    const { computeCorpusVersion, readReconcileVerdict } = await import("@/lib/db/reconcileVerdict");
    const { readConfig } = await import("@/lib/config");
    try {
      await writeSession(projectsDir, "C--dev-a", "s0");
      await ingest.reconcileAllSessions(db, { projectsDir });
      const version = computeCorpusVersion(await readConfig());
      expect(readReconcileVerdict(db, version)?.incomplete).toBe(false);

      const pass = ingest.reconcileAllSessions(db, { projectsDir, shouldStop: () => true });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(readReconcileVerdict(db, version)?.incomplete).toBe(false);
    } finally {
      conn.closeDb();
    }
  });

  it("stops between session directories too, before listing the rest of their subagents/ folders", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      for (let i = 0; i < 5; i++) await fs.mkdir(path.join(projectsDir, "C--dev-a", `session-${i}`), { recursive: true });
      const readdir = vi.spyOn(fs, "readdir");
      // Stop once the first subagents/ listing has been attempted.
      const subagentListings = () => readdir.mock.calls.filter((c) => String(c[0]).endsWith("subagents")).length;
      const pass = ingest.reconcileAllSessions(db, { projectsDir, shouldStop: () => subagentListings() >= 1 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(subagentListings()).toBe(1);
    } finally {
      conn.closeDb();
    }
  });
});

// #683 — a stop inside one large file, and during non-Claude adapter discovery.

const MARKER = "stop-marker-683";

/** Appends `lines` prompt/reply pairs whose prompt carries MARKER and is `lineChars` long. */
async function writeMarkedSession(file: string, lines: number, lineChars: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const timestamp = `2026-10-13T10:00:${String(i % 60).padStart(2, "0")}Z`;
    const text = `${MARKER} ${i} `.padEnd(lineChars, "x");
    out.push(JSON.stringify({ type: "user", timestamp, message: { content: [{ type: "text", text }] } }));
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp,
        message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } },
      })
    );
  }
  await fs.appendFile(file, out.join("\n") + "\n");
}

/** How many of MARKER's lines have been JSON-parsed so far. */
function markerParses(): () => number {
  const spy = vi.spyOn(JSON, "parse");
  return () => spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes(MARKER)).length;
}

describe("yieldThenThrowIfStopped (#683)", () => {
  it("lets a queued stop land before checking, so a check after synchronous work is not stale", async () => {
    const { yieldThenThrowIfStopped } = await import("@/lib/reconcileStop");
    let stopped = false;
    setImmediate(() => (stopped = true));
    await expect(yieldThenThrowIfStopped(() => stopped)).rejects.toMatchObject(STOPPED);
  });
});

describe.skipIf(!driverAvailable)("reconcileSessionFile shouldStop (#683)", () => {
  it("stops after the read, before parsing a line", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      const file = path.join(projectsDir, "C--dev-a", "small.jsonl");
      await writeMarkedSession(file, 2, 100);
      const parses = markerParses();
      const pass = ingest.reconcileSessionFile(db, file, "C--dev-a", { shouldStop: () => true });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(parses()).toBe(0);
    } finally {
      conn.closeDb();
    }
  });

  it("stops partway through parsing a large file", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      const file = path.join(projectsDir, "C--dev-a", "big.jsonl");
      await writeMarkedSession(file, 12, 1024 * 1024); // ~12 MB: several parse checkpoints
      const parses = markerParses();
      const pass = ingest.reconcileSessionFile(db, file, "C--dev-a", { shouldStop: () => parses() > 0 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(parses()).toBeGreaterThan(0);
      expect(parses()).toBeLessThan(12);
    } finally {
      conn.closeDb();
    }
  });

  it("does not write a file whose parse finished after the stop arrived", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      const file = path.join(projectsDir, "C--dev-a", "small.jsonl");
      await writeMarkedSession(file, 2, 100);
      const parses = markerParses();
      const pass = ingest.reconcileSessionFile(db, file, "C--dev-a", { shouldStop: () => parses() > 0 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(sessionCount(db)).toBe(0);
    } finally {
      conn.closeDb();
    }
  });

  it("leaves a tail append unwritten and its cursor where it was", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      await writeSession(projectsDir, "C--dev-a", "tail");
      const file = path.join(projectsDir, "C--dev-a", "tail.jsonl");
      await ingest.reconcileSessionFile(db, file, "C--dev-a");
      const cursor = () => db.prepare("SELECT byte_offset, file_size FROM sessions").get();
      const turnCount = () => (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
      const before = { cursor: cursor(), turns: turnCount() };

      await writeMarkedSession(file, 2, 100);
      const parses = markerParses();
      const pass = ingest.reconcileSessionFile(db, file, "C--dev-a", { shouldStop: () => parses() > 0 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      // An advanced cursor or size would make the next pass skip the appended turns for good.
      expect({ cursor: cursor(), turns: turnCount() }).toEqual(before);
    } finally {
      conn.closeDb();
    }
  });

  it("does not write a non-Claude session parsed after the stop arrived", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      const codexFile = path.join(tmpHome, "codex", "c1.jsonl");
      await fs.mkdir(path.dirname(codexFile), { recursive: true });
      await fs.writeFile(codexFile, "{}\n");
      let parsed = false;
      const pass = ingest.reconcileAllSessions(db, {
        projectsDir,
        adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }],
        parseAdapterFile: async () => {
          parsed = true;
          return [
            {
              sessionId: "c1", timestamp: "2026-10-13T10:00:00Z", source: "codex", project: "codexproj",
              projectDirName: "codexproj", model: "gpt-5", role: "assistant", inputTokens: 1, outputTokens: 1,
              cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [],
            } as never,
          ];
        },
        shouldStop: () => parsed,
      });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(sessionCount(db)).toBe(0);
    } finally {
      conn.closeDb();
    }
  });
});

describe("codex discover shouldStop (#683)", () => {
  function stubCodexHome(): string {
    const home = path.join(tmpHome, "codex-home");
    vi.stubEnv("CODEX_HOME", home);
    return home;
  }

  it("stops while walking the session directories", async () => {
    const home = stubCodexHome();
    try {
      // Empty nested dirs: a walk that never checked would finish and return [] without throwing.
      for (let i = 0; i < 5; i++) await fs.mkdir(path.join(home, "sessions", `d${i}`, "x"), { recursive: true });
      const readdir = vi.spyOn(fs, "readdir");
      const { default: codexAdapter } = await import("@/lib/adapters/codex");
      const pass = codexAdapter.discover({ shouldStop: () => readdir.mock.calls.length > 0 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(readdir.mock.calls.length).toBeLessThan(5);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops between batches of metadata reads", async () => {
    const home = stubCodexHome();
    try {
      const dir = path.join(home, "sessions");
      await fs.mkdir(dir, { recursive: true });
      for (let i = 0; i < 40; i++) {
        const meta = { type: "session_meta", payload: { id: `s${i}`, cwd: "/w" } };
        await fs.writeFile(path.join(dir, `s${i}.jsonl`), JSON.stringify(meta) + "\n");
      }
      const open = vi.spyOn(fs, "open");
      const { default: codexAdapter } = await import("@/lib/adapters/codex");
      const pass = codexAdapter.discover({ shouldStop: () => open.mock.calls.length > 0 });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(open.mock.calls.length).toBeLessThan(40);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!driverAvailable)("a stop during discovery stops the pass instead of reading as a failed discovery", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    const home = stubCodexHome();
    try {
      await fs.mkdir(path.join(home, "sessions", "d0", "x"), { recursive: true });
      const warn = vi.spyOn(console, "warn");
      const readdir = vi.spyOn(fs, "readdir");
      const codexListed = () => readdir.mock.calls.some((c) => String(c[0]).startsWith(home));
      const pass = ingest.reconcileAllSessions(db, {
        projectsDir,
        config: { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters: ["claude", "codex"] },
        shouldStop: codexListed,
      });
      await expect(pass).rejects.toMatchObject(STOPPED);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("adapter discovery failed"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      conn.closeDb();
    }
  });
});
