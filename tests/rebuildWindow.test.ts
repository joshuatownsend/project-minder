import { describe, it, expect } from "vitest";

/**
 * #478 — a `DERIVED_VERSION` rebuild is a distinct unavailability from a first
 * build, and the five derived-value aggregates have to notice it.
 *
 * The condition is not #472's. That one is a PARTIAL corpus and it announces
 * itself: the row count is short. This is a COMPLETE corpus with inconsistent
 * derivations — the count is right and the totals look plausible, which is
 * exactly why it needed a predicate of its own rather than being folded into
 * readiness.
 */

let driverAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

/** The two tables these predicates read, and nothing else. */
function makeDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      session_id      TEXT PRIMARY KEY,
      derived_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE indexer_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at_ms  INTEGER NOT NULL,
      finished_at_ms INTEGER,
      kind           TEXT NOT NULL,
      files_seen     INTEGER NOT NULL DEFAULT 0,
      files_changed  INTEGER NOT NULL DEFAULT 0,
      rows_written   INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      aborted        INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe.skipIf(!driverAvailable)("hasStaleDerivations (#478)", () => {
  it("is false when every row is at the current version", async () => {
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 20)").run();
      expect(hasStaleDerivations(db, 20)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is true when any row lags", async () => {
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 19)").run();
      expect(hasStaleDerivations(db, 20)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("ignores rows derived by a NEWER build", async () => {
    // A rolled-back install leaves rows this build cannot rewrite. Treating
    // them as stale would put the report in a rebuild state that never ends,
    // which is the same asymmetry `isNewerDerivation` documents on the ingest
    // side — hence `<` rather than `!=`.
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 21)").run();
      expect(hasStaleDerivations(db, 20)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is false on an unreadable table rather than claiming a rebuild", async () => {
    // A predicate that cannot read its own evidence must not be the thing that
    // diverts every aggregate to the slower path — the same fail-open rule
    // `hasCompletedFullReconcile` states.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const db = new Database(":memory:");
    try {
      expect(hasStaleDerivations(db, 20)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!driverAvailable)("isRebuildInProgress (#478)", () => {
  it("is true only while a rebuild run is open", async () => {
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      expect(isRebuildInProgress(db)).toBe(false);

      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, kind) VALUES (1, 'rebuild')"
      ).run();
      expect(isRebuildInProgress(db)).toBe(true);

      db.prepare("UPDATE indexer_runs SET finished_at_ms = 2").run();
      expect(isRebuildInProgress(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not fire for an open RECONCILE", async () => {
    // The two windows are different unavailabilities with different messages,
    // and `getEngagement` gates on one and not the other. Conflating them here
    // would divert it too, for a re-derivation it is provably immune to.
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, kind) VALUES (1, 'reconcile')"
      ).run();
      expect(isRebuildInProgress(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!driverAvailable)("recordOptionForSweep (#478)", () => {
  it("records a rebuild even once readiness is established", async () => {
    // Readiness answers "has a full pass ever completed", which stays TRUE
    // through a `DERIVED_VERSION` bump — so the self-limiting check would have
    // skipped recording during exactly the window this exists for.
    const { recordOptionForSweep } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      // Readiness established, no stale rows: nothing to record.
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(DERIVED_VERSION);
      expect(recordOptionForSweep(db)).toEqual({});

      // Same readiness, one lagging row.
      db.prepare("INSERT INTO sessions VALUES ('b', ?)").run(DERIVED_VERSION - 1);
      expect(recordOptionForSweep(db)).toEqual({ recordRun: "rebuild" });
    } finally {
      db.close();
    }
  });
});
