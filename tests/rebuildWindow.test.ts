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

describe("every consumer of the rebuild window is wired to it (#478)", () => {
  /**
   * Source-level, because the alternative is standing up a DB backend with a
   * half-re-derived corpus per consumer, and the thing that actually goes wrong
   * is a MISSING CALL — which is exactly what a source check catches.
   *
   * `getUsageCompare` was the one that got missed (Codex P1, PR #525). It does
   * not go through `checkBuildStateFallback` at all: it DEGRADES to a
   * not-comparable result instead of falling back, so it carries its own copy
   * of every unavailability and a new one has to be added by hand.
   */
  it("gates both the shared fallback and the compare route", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/lib/data/index.ts", "utf-8");

    // The shared gate the five derived-value loaders run through.
    const fallback = src.slice(
      src.indexOf("async function checkBuildStateFallback"),
      src.indexOf("function isIndexBuilding")
    );
    expect(fallback).toMatch(/isRebuildInProgress\(db\)/);

    // And `getUsageCompare`, which does not.
    const compare = src.slice(src.indexOf("export async function getUsageCompare"));
    expect(compare).toMatch(/isRebuildInProgress\(db\)/);
    // Degrades, never diverts — there is no file-parse compare path, and two
    // differently-derived windows make an arbitrary delta rather than a
    // subset-shaped one.
    expect(compare).toMatch(/buildNotComparable\(/);
  });

  it("leaves getEngagement alone", async () => {
    // It reads raw columns only — `ts`, `role`, `text_preview`, `entrypoint`,
    // `is_sidechain` — all of which survive a re-derivation. Diverting it would
    // take a report offline for a condition it is provably immune to, and its
    // own comment already said as much.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/lib/data/index.ts", "utf-8");
    const engagement = src.slice(
      src.indexOf("export async function getEngagement"),
      src.indexOf("export async function getEngagement") + 3000
    );
    expect(engagement).not.toMatch(/isRebuildInProgress/);
  });
});
