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
      // Nothing is credited to an index nobody has recorded a pass against —
      // including an existing one. Crediting a non-empty `sessions` table was
      // tried and removed: reconcile commits per file, so a killed pass leaves
      // rows behind and non-emptiness never proved a full pass finished.
      // (Codex P1, PR #471.)
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

  it("lets a later sweep establish readiness after an aborted initial pass", async () => {
    // Copilot, #471 — the second half of Codex's P1, which the first fix missed.
    // The initial reconcile does not retry, and sweeps normally record nothing,
    // so an aborted initial pass would leave readiness latched off FOREVER: the
    // engagement report 503'ing permanently on an index that sweeps had long
    // since populated. A fix for a wrong number becoming a standing outage.
    const { conn, db, runs } = await freshDb();
    try {
      // The initial pass dies mid-run and the next startup closes it.
      runs.beginIndexerRun(db, "reconcile");
      runs.closeOrphanedIndexerRuns(db);
      expect(runs.getIndexBuildState(db)).toBe("building");

      // A sweep in that state records, because nothing else can clear the latch.
      expect(runs.recordOptionForSweep(db)).toEqual({ recordRun: "reconcile" });
      const id = runs.beginIndexerRun(db, "reconcile");
      runs.finishIndexerRun(db, id, { filesSeen: 40 });
      expect(runs.getIndexBuildState(db)).toBe("ready");

      // ...and stops recording immediately after, so the steady state is still
      // zero rows per sweep rather than one every 30 seconds forever.
      expect(runs.recordOptionForSweep(db)).toEqual({});
    } finally {
      conn.closeDb();
    }
  });

  it("does not latch on a pass that could not enumerate a directory", async () => {
    // Codex P1, #471. A transient readdir failure is CAUGHT — the pass returns
    // ordinary stats rather than throwing — so without surfacing it, a run that
    // never saw an entire Claude home recorded `aborted = 0` and permanently
    // marked the index ready. The timecard would then return exactly the partial
    // total this gate exists to prevent.
    //
    // Drives the real path rather than passing `aborted` in: an earlier version
    // of this test called `finishIndexerRun({ aborted: true })` directly, which
    // exercised the predicate and NOT the wiring that sets it — and passed
    // against an implementation with that wiring deliberately removed.
    const { conn, db, runs } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    const fsp = await import("fs");
    // A regular file where a directory is expected: `readdir` throws ENOTDIR,
    // which is caught exactly like a transient UNC error.
    const notADir = `${tmpHome}/not-a-projects-dir`;
    fsp.writeFileSync(notADir, "x");
    try {
      await reconcileAllSessions(db, { projectsDir: notADir, recordRun: "reconcile" });
      const row = db
        .prepare("SELECT aborted, error FROM indexer_runs")
        .get() as { aborted: number; error: string | null };
      expect(row.aborted).toBe(1);
      expect(row.error).toMatch(/could not be listed/);
      expect(runs.getIndexBuildState(db)).toBe("building");
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("does not claim to be building when the indexer is switched off", async () => {
    // With MINDER_INDEXER=0 nothing is reading the corpus and nothing ever will,
    // so the latch would never clear — a permanent outage rather than a wait.
    // The operator has taken ownership of freshness; "still indexing" would be
    // a false statement about what the process is doing.
    const { conn, db, runs } = await freshDb();
    const prev = process.env.MINDER_INDEXER;
    try {
      expect(runs.getIndexBuildState(db)).toBe("building");
      process.env.MINDER_INDEXER = "0";
      expect(runs.getIndexBuildState(db)).toBe("ready");
    } finally {
      if (prev === undefined) delete process.env.MINDER_INDEXER;
      else process.env.MINDER_INDEXER = prev;
      conn.closeDb();
    }
  });

  it("treats an absent projects root as empty, not as a failed read", async () => {
    // Codex P1, #471 — a regression from the previous fix. `~/.claude/projects`
    // is legitimately absent on a WSL-only setup with a configured extra home,
    // and on any machine with Claude Code installed but no sessions yet.
    // Counting ENOENT as an incomplete enumeration marked EVERY pass aborted:
    // no completed run was ever recorded, each sweep repeated the outcome, and
    // the timecard stayed permanently unavailable while the readable home had
    // in fact been scanned in full.
    const { conn, db, runs } = await freshDb();
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    try {
      await reconcileAllSessions(db, {
        projectsDir: `${tmpHome}/definitely-not-here/projects`,
        recordRun: "reconcile",
      });
      const row = db
        .prepare("SELECT aborted, error FROM indexer_runs")
        .get() as { aborted: number; error: string | null };
      expect(row.aborted).toBe(0);
      expect(row.error).toBeNull();
      // Nothing to read is not the same as failing to read: the pass completed.
      expect(runs.getIndexBuildState(db)).toBe("ready");
    } finally {
      conn.closeDb();
    }
  }, 60_000);

  it("stops recording sweeps once the aborted runs have made their point", async () => {
    // A sweep records every 30 s while readiness is unestablished. With a
    // persistent enumeration failure that is ~2,880 rows a day, forever. Not
    // raised in review; a growth path this design introduced.
    const { conn, db, runs } = await freshDb();
    try {
      for (let i = 0; i < 20; i++) {
        const id = runs.beginIndexerRun(db, "reconcile");
        runs.finishIndexerRun(db, id, { aborted: true, error: "unreadable" });
      }
      // Still building — the index genuinely cannot be read, which is correct.
      expect(runs.getIndexBuildState(db)).toBe("building");
      // ...but the table stops growing.
      expect(runs.recordOptionForSweep(db)).toEqual({});
    } finally {
      conn.closeDb();
    }
  });

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
