import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import { installIsolatedState } from "./_helpers/isolatedState";

// #470 — whether the index has finished populating, recorded in the index so a
// reader in another process (the packaged default runs ingest in a
// `worker_threads` thread) can see it.
//
// The consumer that forced this is `getEngagement`: it reports billable hours,
// and answering from a half-built index returns a SUBSET of the user's work
// presented as the total. "0.0 hours" is indistinguishable from a true zero.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-runs-test-" });
let tmpHome: string;

async function freshDb() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const runs = await import("@/lib/db/indexerRuns");
  await mig.initDb();
  const db = await conn.getDb();
  return { conn, db: db!, runs };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("indexer run tracking (#470)", () => {
  it("reports building on an index that has never completed a pass", async () => {
    const { conn, db, runs } = await freshDb();
    try {
      // A fresh index has no sessions, so migration 26 credits it with nothing
      // — which is the honest answer: nothing has read the corpus yet.
      expect(db.prepare("SELECT COUNT(*) AS n FROM indexer_runs").get()).toEqual({ n: 0 });
      expect(runs.getIndexBuildState(db)).toBe("building");
    } finally {
      conn.closeDb();
    }
  });

  it("stays building while the first pass is open, and flips when it closes", async () => {
    const { conn, db, runs } = await freshDb();
    try {
      const id = runs.beginIndexerRun(db, "reconcile");
      expect(id).not.toBeNull();
      // An OPEN run is not a completed one.
      expect(runs.getIndexBuildState(db)).toBe("building");

      runs.finishIndexerRun(db, id, { filesSeen: 12, filesChanged: 12, rowsWritten: 340 });
      expect(runs.getIndexBuildState(db)).toBe("ready");

      const row = db
        .prepare("SELECT files_seen, files_changed, rows_written, error FROM indexer_runs")
        .get() as { files_seen: number; rows_written: number; error: string | null };
      expect(row.files_seen).toBe(12);
      expect(row.rows_written).toBe(340);
      expect(row.error).toBeNull();
    } finally {
      conn.closeDb();
    }
  });

  it("counts a pass with per-file errors as completed", async () => {
    // A run that hit unparseable transcripts still populated the index. Reading
    // `error IS NOT NULL` as "never indexed" would hold the timecard offline
    // indefinitely over one bad file.
    const { conn, db, runs } = await freshDb();
    try {
      const id = runs.beginIndexerRun(db, "reconcile");
      runs.finishIndexerRun(db, id, { filesSeen: 10, error: "2 file(s) failed to parse" });
      // Not aborted: the pass finished and the index is populated. This is the
      // case that stops `aborted` from simply being `error IS NOT NULL`.
      expect(runs.getIndexBuildState(db)).toBe("ready");
    } finally {
      conn.closeDb();
    }
  });

  it("closes a run orphaned by a process that died mid-pass", async () => {
    // Without this the gate lies permanently: one kill during the first
    // reconcile leaves finished_at_ms NULL forever.
    const { conn, db, runs } = await freshDb();
    try {
      runs.beginIndexerRun(db, "reconcile");
      expect(runs.closeOrphanedIndexerRuns(db)).toBe(1);

      const row = db
        .prepare("SELECT finished_at_ms, error, aborted FROM indexer_runs")
        .get() as { finished_at_ms: number | null; error: string; aborted: number };
      expect(row.finished_at_ms).not.toBeNull();
      expect(row.error).toBe("orphaned");
      expect(row.aborted).toBe(1);

      // Closing an orphan does NOT count as having read the corpus — the pass
      // was interrupted, not completed. The original version of this test said
      // exactly that in a comment and then asserted "ready", ratifying the
      // defect it described. (Copilot, PR #471.)
      expect(runs.getIndexBuildState(db)).toBe("building");
    } finally {
      conn.closeDb();
    }
  });

  it("records a pass only when asked, so the 30 s sweep does not", async () => {
    // The watcher re-runs `reconcileAllSessions` every 30 s for the life of the
    // process. Recording unconditionally would write a row every half minute
    // forever; only the INITIAL pass changes what the index can answer.
    const { conn, db } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const projectsDir = `${tmpHome}/.claude/projects`;
    try {
      await reconcileAllSessions(db, { projectsDir });
      expect(db.prepare("SELECT COUNT(*) AS n FROM indexer_runs").get()).toEqual({ n: 0 });

      await reconcileAllSessions(db, { projectsDir, recordRun: "reconcile" });
      const rows = db
        .prepare("SELECT kind, finished_at_ms FROM indexer_runs")
        .all() as Array<{ kind: string; finished_at_ms: number | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("reconcile");
      // Closed, not left open — the recording happens in a `finally`.
      expect(rows[0].finished_at_ms).not.toBeNull();
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("closes the run even when the pass throws", async () => {
    // A throw that left the row open would latch the gate on until something
    // else cleared it.
    const { conn, db } = await freshDb();
    const ingest = await import("@/lib/db/ingest");
    const configMod = await import("@/lib/config");
    // Fail the pass itself rather than an individual file: per-file errors are
    // counted and the pass still completes, which is a different code path.
    const spy = vi
      .spyOn(configMod, "readConfig")
      .mockRejectedValue(new Error("config unreadable"));
    try {
      await expect(
        ingest.reconcileAllSessions(db, {
          projectsDir: `${tmpHome}/.claude/projects`,
          recordRun: "reconcile",
        })
      ).rejects.toThrow("config unreadable");
      const row = db
        .prepare("SELECT finished_at_ms, error, aborted FROM indexer_runs")
        .get() as
        | { finished_at_ms: number | null; error: string | null; aborted: number }
        | undefined;
      expect(row?.finished_at_ms).not.toBeNull();
      expect(row?.error).toBe("reconcile threw");
      // Finished is not completed: a thrown pass never read the corpus through,
      // so it must not satisfy the readiness latch.
      expect(row?.aborted).toBe(1);
      const runs = await import("@/lib/db/indexerRuns");
      expect(runs.getIndexBuildState(db)).toBe("building");
    } finally {
      spy.mockRestore();
      conn.closeDb();
    }
  }, 60_000);

  it("refuses the engagement report until the index has been read through", async () => {
    // The consumer this exists for. A SQL answer from a half-built index is a
    // subset of the user's work presented as the total, and this is the
    // billable-hours figure — so it refuses rather than under-reports.
    const { conn, db, runs } = await freshDb();
    const data = await import("@/lib/data");
    const { DEFAULT_ENGAGEMENT_CONFIG } = await import("@/lib/engagement/config");
    try {
      await expect(
        data.getEngagement("7d", "UTC", DEFAULT_ENGAGEMENT_CONFIG)
      ).rejects.toMatchObject({ name: "DbUnavailableError", reason: "index-building" });

      // The reason is distinguishable from "the database is off", because the
      // route surfaces `reason` on its 503 and the two need different copy.
      await expect(
        data.getEngagement("7d", "UTC", DEFAULT_ENGAGEMENT_CONFIG)
      ).rejects.not.toMatchObject({ reason: "driver-missing" });

      const id = runs.beginIndexerRun(db, "reconcile");
      runs.finishIndexerRun(db, id, { filesSeen: 0 });

      // Now it answers. Empty, because this index has no sessions — but that
      // zero is now a measured one rather than an artefact of not having looked.
      const { report } = await data.getEngagement("7d", "UTC", DEFAULT_ENGAGEMENT_CONFIG);
      expect(report).toBeTruthy();
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("does not gate when it cannot read its own evidence", async () => {
    // A readiness check that fails closed converts a schema problem into a
    // silent outage of a working report. It fails open instead.
    const { conn, db, runs } = await freshDb();
    try {
      db.exec("DROP TABLE indexer_runs");
      expect(runs.hasCompletedFullReconcile(db)).toBe(true);
      expect(runs.getIndexBuildState(db)).toBe("ready");
    } finally {
      conn.closeDb();
    }
  });
});
