import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #595 — where the initial reconcile spends its time.
//
// The pass took 689 -> 849 -> 1261 s across three boots to handle ~14k files of
// which ONE changed, and nothing recorded which phase those minutes belong to.
// The summary line is the instrument; these tests pin what it promises: one line
// per pass that opts in with `logTiming` (the initial pass; never the 30 s sweep,
// and not merely any RECORDED pass — recovery sweeps are recorded too), naming
// every phase it timed, with the untimed remainder surfaced as `other`.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-reconcile-timing-" });
let tmpHome: string;
const logSpy = vi.fn();

async function freshDb() {
  await state.reload();
  vi.doMock("@/lib/serviceLog", () => ({ serviceLog: logSpy }));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  await mig.initDb();
  const db = await conn.getDb();
  return { conn, db: db! };
}

async function writeSession(projectsDir: string, dirName: string, id: string): Promise<void> {
  const file = path.join(projectsDir, dirName, `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-09-30T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } },
    {
      type: "assistant",
      timestamp: "2026-09-30T10:00:01Z",
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const timingLines = () =>
  logSpy.mock.calls
    .map((c) => c[0] as Record<string, unknown> & { msg: string; phaseMs: Record<string, number> })
    .filter((e) => /^reconcile finished in \d+ ms$/.test(e.msg));

beforeEach(() => {
  tmpHome = state.tmpHome();
  logSpy.mockClear();
});

afterEach(() => {
  vi.doUnmock("@/lib/serviceLog");
  vi.restoreAllMocks();
});

describe.skipIf(!driverAvailable)("reconcile phase timing (#595)", () => {
  it("logs one summary for a recorded pass, naming every phase it timed", async () => {
    const { conn, db } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    try {
      await writeSession(projectsDir, "C--dev-a", "s1");
      await writeSession(projectsDir, "C--dev-b", "s2");
      // A session dir with a subagents/ folder, so the enumeration counter moves.
      await fs.mkdir(path.join(projectsDir, "C--dev-a", "s1", "subagents"), { recursive: true });

      await reconcileAllSessions(db, { projectsDir, recordRun: "reconcile", logTiming: true });

      const lines = timingLines();
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line.kind).toBe("reconcile");
      expect(line.filesSeen).toBe(2);
      expect(line.filesChanged).toBe(2);
      expect(line.subagentReaddirs).toBe(1);
      expect(typeof line.totalMs).toBe("number");

      // Every phase the walk actually runs with an explicit projectsDir.
      for (const phase of ["pricing", "config", "adapterDiscovery", "enumerate", "perFile", "prune", "other"]) {
        expect(line.phaseMs, `missing phase ${phase}`).toHaveProperty(phase);
      }
      // `homes` belongs to the discovered-homes branch; an explicit dir skips it,
      // and a phase that did not run must not be reported as zero time.
      expect(line.phaseMs).not.toHaveProperty("homes");

      // The phases plus the untimed remainder account for the whole pass, to
      // within a millisecond of rounding per phase — `other` exists so nothing
      // is lost, which is the property that makes the breakdown trustworthy.
      const sum = Object.values(line.phaseMs).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - (line.totalMs as number))).toBeLessThanOrEqual(1);
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("stays silent for a recorded pass that did not ask for timing (recovery sweeps are recorded too)", async () => {
    const { conn, db } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    try {
      await writeSession(projectsDir, "C--dev-a", "s1");
      await reconcileAllSessions(db, { projectsDir, recordRun: "reconcile" });
      await reconcileAllSessions(db, { projectsDir, recordRun: "rebuild" });
      expect(timingLines()).toHaveLength(0);
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("names the prune phase when a synchronous DB phase throws", async () => {
    const { conn, db } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    try {
      await writeSession(projectsDir, "C--dev-a", "s1");
      await reconcileAllSessions(db, { projectsDir });
      const realPrepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (/SELECT session_id, project_slug, file_path, derived_version FROM sessions/.test(sql)) {
          throw new Error("prune select failed");
        }
        return realPrepare(sql);
      }) as typeof db.prepare);
      try {
        await expect(
          reconcileAllSessions(db, { projectsDir, recordRun: "reconcile", logTiming: true })
        ).rejects.toThrow("prune select failed");
      } finally {
        spy.mockRestore();
      }
      const threw = logSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown> & { msg: string; phaseMs: Record<string, number> })
        .filter((e) => /^reconcile threw after \d+ ms$/.test(e.msg));
      expect(threw).toHaveLength(1);
      expect(threw[0].phaseMs).toHaveProperty("prune");
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("stays silent for an unrecorded pass, so the 30 s sweep does not spam the log", async () => {
    const { conn, db } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    try {
      await writeSession(projectsDir, "C--dev-a", "s1");
      await reconcileAllSessions(db, { projectsDir });
      await reconcileAllSessions(db, { projectsDir });
      expect(timingLines()).toHaveLength(0);
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("still reports, at warn level, when the pass throws - that is when 'where did it die' matters", async () => {
    const { conn, db } = await freshDb();
    const ingest = await import("@/lib/db/ingest");
    const configMod = await import("@/lib/config");
    // Fail the pass itself, not one file: per-file errors are counted and the
    // pass still completes, which is a different path.
    const spy = vi.spyOn(configMod, "readConfig").mockRejectedValue(new Error("config unreadable"));
    try {
      await expect(
        ingest.reconcileAllSessions(db, {
          projectsDir: path.join(tmpHome, ".claude", "projects"),
          recordRun: "reconcile",
          logTiming: true,
        })
      ).rejects.toThrow("config unreadable");

      const threw = logSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown> & { msg: string; level: string; phaseMs: Record<string, number> })
        .filter((e) => /^reconcile threw after \d+ ms$/.test(e.msg));
      expect(threw).toHaveLength(1);
      expect(threw[0].level).toBe("warn");
      // The phase that was running when it died is in the breakdown.
      expect(threw[0].phaseMs).toHaveProperty("config");
      // No stats exist for a pass that threw, and none are invented.
      expect(threw[0].filesSeen).toBeUndefined();
      expect(timingLines()).toHaveLength(0);
    } finally {
      spy.mockRestore();
      conn.closeDb();
    }
  }, 60_000);
});
