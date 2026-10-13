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

const sessionCount = (db: import("better-sqlite3").Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

describe.skipIf(!driverAvailable)("reconcileAllSessions shouldStop (#677)", () => {
  it("stops partway through the walk and throws ReconcileStoppedError", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    try {
      for (let i = 0; i < 6; i++) await writeSession(projectsDir, i < 3 ? "C--dev-a" : "C--dev-b", `s${i}`);
      // Stop once two files have been written, whatever order the directories list in.
      const pass = ingest.reconcileAllSessions(db, { projectsDir, shouldStop: () => sessionCount(db) >= 2 });
      await expect(pass).rejects.toBeInstanceOf(ingest.ReconcileStoppedError);
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
      await expect(pass).rejects.toBeInstanceOf(ingest.ReconcileStoppedError);
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
      await expect(pass).rejects.toBeInstanceOf(ingest.ReconcileStoppedError);
      expect(runs.getIndexBuildState(db)).toBe("building");
    } finally {
      conn.closeDb();
    }
  });
});
