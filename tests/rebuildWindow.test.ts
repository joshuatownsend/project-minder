import { describe, it, expect, beforeEach } from "vitest";

/**
 * #478 — a `DERIVED_VERSION` rebuild is a distinct unavailability from a first
 * build, and the five derived-value aggregates have to notice it.
 *
 * The condition is not #472's. That one is a PARTIAL corpus and it announces
 * itself: the row count is short. This is a COMPLETE corpus with inconsistent
 * derivations — the count is right and the totals look plausible, which is
 * exactly why it needed a predicate of its own rather than being folded into
 * readiness.
 *
 * Every case below is expressed RELATIVE to `DERIVED_VERSION`. Hardcoding the
 * current number would make these fail on the next bump while the behaviour
 * under test was unchanged — and a bump is routine, since any cost or
 * classifier formula change needs one (Copilot, PR #525).
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

beforeEach(async () => {
  // The memo lives on `globalThis`, so it survives between test files.
  const { clearStaleDerivationMemo } = await import("@/lib/db/indexerRuns");
  clearStaleDerivationMemo();
});

describe.skipIf(!driverAvailable)("hasStaleDerivations (#478)", () => {
  it("is false when every row is at the current version", async () => {
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V);
      expect(hasStaleDerivations(db, V)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is true when any row lags", async () => {
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V - 1);
      expect(hasStaleDerivations(db, V)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("ignores rows derived by a NEWER build", async () => {
    // A rolled-back install leaves rows this build cannot rewrite. Treating
    // them as stale would put the report in a rebuild state that never ends —
    // the same asymmetry `isNewerDerivation` documents on the ingest side,
    // which is why this is `<` and not `!=`.
    const { hasStaleDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(V + 1);
      expect(hasStaleDerivations(db, V)).toBe(false);
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
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = new Database(":memory:");
    try {
      expect(hasStaleDerivations(db, V)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!driverAvailable)("isRebuildInProgress (#478)", () => {
  it("tracks STALE ROWS, not an open run", async () => {
    // The first version asked whether an open `'rebuild'` run existed, and that
    // proxy was wrong both ways: the production rebuild happens during the
    // INITIAL reconcile, recorded as `'reconcile'` (so it never fired), and a
    // pass that finishes with files unparseable closes its run while leaving
    // the index mixed (so it stopped firing too early). Codex P1 + P2, #525.
    const { isRebuildInProgress, clearStaleDerivationMemo } = await import(
      "@/lib/db/indexerRuns"
    );
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(V - 1);
      // No run row of any kind — and it still fires, which the run-based
      // version could not.
      expect(isRebuildInProgress(db)).toBe(true);

      // A CLOSED run does not clear it either; only the rows do.
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      clearStaleDerivationMemo();
      expect(isRebuildInProgress(db)).toBe(true);

      db.prepare("UPDATE sessions SET derived_version = ?").run(V);
      clearStaleDerivationMemo();
      expect(isRebuildInProgress(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("memoizes, so the scan is not paid per request", async () => {
    // The scan is 24 ms when the answer is "none", which is the common case and
    // the expensive one. Asserted by CHANGING the rows underneath and observing
    // the stale answer — a test that only called it twice would pass whether or
    // not the memo existed.
    const { isRebuildInProgress, clearStaleDerivationMemo } = await import(
      "@/lib/db/indexerRuns"
    );
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(V);
      expect(isRebuildInProgress(db)).toBe(false);

      db.prepare("UPDATE sessions SET derived_version = ?").run(V - 1);
      // Still the memoized answer.
      expect(isRebuildInProgress(db)).toBe(false);

      clearStaleDerivationMemo();
      expect(isRebuildInProgress(db)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!driverAvailable)("recordOptionForSweep (#478)", () => {
  it("does not record a run for a rebuild", async () => {
    // It did, briefly. Recording one per 30 s sweep grew `indexer_runs` for as
    // long as any row stayed stale, and the run told the predicate nothing it
    // could not read from the rows directly (Copilot, PR #525).
    const { recordOptionForSweep } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(V - 1);
      expect(recordOptionForSweep(db)).toEqual({});
    } finally {
      db.close();
    }
  });
});
