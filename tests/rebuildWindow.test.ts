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
   * Two ways an index fails to be servable, and one way it does not.
   *
   * `derivationVersion.ts` is the authority and it is explicit: "'Stale' means
   * `stored < DERIVED_VERSION`, never `stored !== DERIVED_VERSION`." Rows above
   * this build came from one that knows more, and re-deriving them here would
   * drop columns it added — so a uniformly newer index is left alone rather
   * than diverted forever.
   */
  it("is false when every row is at the current version", async () => {
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V);
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is false for an EMPTY index", async () => {
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const db = makeDb();
    try {
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is true when the rows disagree", async () => {
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V - 1);
      expect(hasMixedDerivations(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is true when every row is UNIFORMLY stale", async () => {
    // Consistent with each other and still invalidated: `derivationVersion.ts`
    // says a stale row "is fully re-parsed even when its file mtime hasn't
    // changed", so serving it is serving figures this build declared wrong.
    // I had this returning false, reasoning that a uniform index is coherent —
    // coherence is not the test (Codex P2, PR #525).
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V - 1, V - 1);
      expect(hasMixedDerivations(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is true after a ROLLBACK left newer rows beside current ones", async () => {
    // The mixed case reached from the other side, and the one a `<`-only test
    // missed: `isNewerDerivation` stops the older watcher rewriting the newer
    // half, so the mixture is permanent.
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V + 1);
      expect(hasMixedDerivations(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is FALSE when the whole corpus is newer", async () => {
    // The one case that is not this build's to fix. Diverting forever would be
    // the endless state, and `derivationVersion.ts` is explicit that these rows
    // must not be treated as stale.
    const { hasMixedDerivations } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V + 1, V + 1);
      expect(hasMixedDerivations(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is false on an unreadable table rather than claiming a rebuild", async () => {
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
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V);
      expect(isRebuildInProgress(db)).toBe(false);

      db.prepare("UPDATE sessions SET derived_version = ? WHERE session_id = 'b'").run(V - 1);
      expect(isRebuildInProgress(db)).toBe(true);

      db.prepare("UPDATE sessions SET derived_version = ?").run(V);
      expect(isRebuildInProgress(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("stays up through the rollup refresh after the last row is stamped", async () => {
    // `hasMixedDerivations` goes false the instant the last session transaction
    // commits, but `reconcileAllSessions` refreshes `daily_costs` and
    // `category_costs` AFTER that — so for the length of that tail every
    // `derived_version` agrees while the rollups the aggregates read do not
    // (Codex P1, PR #525).
    //
    // The run row lives in the DATABASE, which is the property every
    // in-process signal lacked: reconciliation runs in a worker thread whose
    // memory the HTTP server does not share.
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      // Every row stamped current — the rows alone say "done".
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V);
      expect(isRebuildInProgress(db)).toBe(false);

      // ...but the pass has not finished.
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

  it("does not depend on any run row", async () => {
    // The first version asked whether an open `'rebuild'` run existed. In
    // production the re-derivation happens during the INITIAL reconcile, which
    // is recorded as `'reconcile'`, so that predicate was false for the entire
    // real rebuild (Codex P1, PR #525).
    const { isRebuildInProgress } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V - 1, V);
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
  it("records a rebuild even once readiness is established", async () => {
    // Readiness answers "has a full pass ever completed", which stays TRUE
    // through a `DERIVED_VERSION` bump — so the self-limiting check would skip
    // recording during exactly the window the run row exists to cover.
    const { recordOptionForSweep } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V - 1);
      expect(recordOptionForSweep(db)).toEqual({ recordRun: "rebuild" });
    } finally {
      db.close();
    }
  });

  it("does not record a rebuild for a rollback remnant", async () => {
    // Current rows beside NEWER ones are mixed forever — `isNewerDerivation`
    // stops this build rewriting the newer half — so there is nothing for a
    // pass to do and no rollup tail to cover. Recording one every 30 s would be
    // pure accumulation (Codex P2, PR #525).
    //
    // The DIVERSION still fires for this state; only the recording does not.
    // Asserted together, because the two conditions are deliberately different
    // and a "simplification" that unified them would break one.
    const { recordOptionForSweep, isRebuildInProgress } = await import(
      "@/lib/db/indexerRuns"
    );
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V + 1);

      expect(isRebuildInProgress(db)).toBe(true);
      expect(recordOptionForSweep(db)).toEqual({});
    } finally {
      db.close();
    }
  });

  it("keeps completed rebuild rows bounded", async () => {
    // A stale row left by a permanently unparseable file keeps every sweep
    // eligible to record. Capping the RECORDING would be wrong for the reason
    // `ABORTED_RUN_KEEP_LIMIT` gives — the sweep that finally succeeds still
    // has to be free to record — so the rows are pruned instead.
    const { recordOptionForSweep } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(V - 1);
      const insert = db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (?, ?, 'rebuild', 0)"
      );
      for (let i = 0; i < 60; i++) insert.run(i, i + 1);

      // Still records — that is the point — and prunes on the way.
      expect(recordOptionForSweep(db)).toEqual({ recordRun: "rebuild" });
      const left = db
        .prepare("SELECT COUNT(*) AS c FROM indexer_runs WHERE kind = 'rebuild'")
        .get() as { c: number };
      expect(left.c).toBeLessThanOrEqual(20);
    } finally {
      db.close();
    }
  });

  it("does not record a SECOND rebuild while one is open", async () => {
    // A rebuild spanning many 30 s sweeps must add one row, not one per sweep.
    const { recordOptionForSweep } = await import("@/lib/db/indexerRuns");
    const { DERIVED_VERSION: V } = await import("@/lib/db/derivationVersion");
    const db = makeDb();
    try {
      // A completed reconcile, so readiness is established and the only reason
      // left to record anything is the rebuild.
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, finished_at_ms, kind, aborted) VALUES (1, 2, 'reconcile', 0)"
      ).run();
      db.prepare("INSERT INTO sessions VALUES ('a', ?), ('b', ?)").run(V, V - 1);
      db.prepare(
        "INSERT INTO indexer_runs (started_at_ms, kind) VALUES (3, 'rebuild')"
      ).run();
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
