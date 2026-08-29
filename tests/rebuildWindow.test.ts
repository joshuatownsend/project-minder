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

describe.skipIf(!driverAvailable)("hasMixedDerivations (#478)", () => {
  /**
   * The question is COEXISTENCE, and every case is expressed without reference
   * to the current `DERIVED_VERSION` — because the predicate no longer needs
   * one. That also settles the hardcoding Copilot flagged (PR #525): there is
   * nothing left to hardcode.
   */
  it("is false when every row agrees", async () => {
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 20)").run();
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is false for an EMPTY index", async () => {
    // Nothing to disagree. A fresh install must not read as mid-rebuild.
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is true mid-rebuild, with old and new side by side", async () => {
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 19)").run();
      expect(hasMixedDerivations(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is true after a ROLLBACK left newer rows beside current ones", async () => {
    // The case `< DERIVED_VERSION` missed. A newer build re-derived part of the
    // corpus, then the app rolled back; `isNewerDerivation` deliberately stops
    // the older watcher rewriting the newer half, so the mixture is PERMANENT
    // and the aggregates would have served it forever (Codex P2, PR #525).
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 21)").run();
      expect(hasMixedDerivations(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is false when the WHOLE corpus is newer", async () => {
    // A clean rollback after a complete re-derivation. Every row agrees, so the
    // figures are internally consistent — merely produced by a build we do not
    // have. Diverting here is the endless rebuild state the original `<` was
    // reaching for, and it is the one case that reasoning got right.
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 21), ('b', 21)").run();
      expect(hasMixedDerivations(db)).toBe(false);
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
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = new Database(":memory:");
    try {
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!driverAvailable)("isRebuildInProgress (#478)", () => {
  it("reads the database every time, with nothing cached", async () => {
    // Three attempts at caching this failed, each to a different window, and
    // the last to a wall (Codex P1 x4, PR #525): a 30-second memo; clearing it
    // at the reconcile's edges; a live flag set on the first re-derived row.
    // The flag is the one that settles it — reconciliation runs in
    // `workers/ingestWorker.mjs`, whose `globalThis` the HTTP server does not
    // share, so no in-process signal can answer a question about work another
    // process is doing.
    //
    // Asserted by CHANGING the rows and reading again with no reset in
    // between. Every cached version of this failed exactly that.
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 20), ('b', 20)").run();
      expect(isRebuildInProgress(db)).toBe(false);

      db.prepare("UPDATE sessions SET derived_version = 19 WHERE session_id = 'b'").run();
      expect(isRebuildInProgress(db)).toBe(true);

      db.prepare("UPDATE sessions SET derived_version = 20").run();
      expect(isRebuildInProgress(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not depend on any run row", async () => {
    // The first version asked whether an open `'rebuild'` run existed. In
    // production the re-derivation happens during the INITIAL reconcile, which
    // is recorded as `'reconcile'`, so that predicate was false for the entire
    // real rebuild (Codex P1, PR #525).
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', 19), ('b', 20)").run();
      // No run row of any kind, and it still fires.
      expect(isRebuildInProgress(db)).toBe(true);

      // A CLOSED reconcile does not clear it either; only the rows do.
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
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
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      db.prepare("INSERT INTO sessions VALUES ('a', 19), ('b', 20)").run();
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

  it("ships the index that makes the per-request read affordable", async () => {
    // Without `idx_sessions_derived_version` this is a full scan whenever the
    // rows agree — the common case, ~24 ms on a 6,602-session index. That cost
    // is what drove three failed attempts to cache the answer. The index is
    // load-bearing for the design, not an optimisation on top of it, so it is
    // asserted in both places a database can come from.
    const { readFile } = await import("node:fs/promises");
    const schema = await readFile("src/lib/db/schema.sql", "utf-8");
    expect(schema).toMatch(/idx_sessions_derived_version/);
    const migrations = await readFile("src/lib/db/migrations.ts", "utf-8");
    expect(migrations).toMatch(/idx_sessions_derived_version/);
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
