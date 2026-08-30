/**
 * #529 — the DB reconcile's completeness verdict.
 *
 * `/api/claude-homes` reported `complete: true` when the reconcile could not
 * read the corpus. #513 instrumented the two FILE sweeps; the DB pass was left
 * out, and it is the DEFAULT backend — so the answer most users actually get
 * was the wrong one.
 *
 * Reading the existing `indexer_runs.aborted` bit was tried in PR #527 and
 * reverted after four rounds. These tests pin the two findings that reverted it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseT } from "better-sqlite3";
import type { MinderConfig } from "@/lib/types";
import {
  computeCorpusVersion,
  writeReconcileVerdict,
  readReconcileVerdict,
} from "@/lib/db/reconcileVerdict";

let db: DatabaseT;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;");
});

afterEach(() => {
  db.close();
});

const cfg = (over: Partial<MinderConfig> = {}): MinderConfig =>
  ({ claudeHomes: [], enabledAdapters: ["claude"], ...over }) as MinderConfig;

describe("computeCorpusVersion", () => {
  it("ignores order and duplicate spellings of the same home", () => {
    // The same comparison `/api/config`'s `corpusShapeChanged` makes: a reorder
    // or an equivalent spelling is not a different corpus, and treating it as
    // one would discard a live verdict for no reason.
    const a = computeCorpusVersion(cfg({ claudeHomes: ["C:/a", "C:/b"] }));
    const b = computeCorpusVersion(cfg({ claudeHomes: ["C:/b", "C:/a"] }));
    expect(a).toBe(b);
  });

  it("treats an absent enabledAdapters as the default set, not as different", () => {
    // The substrate adapter is always in the effective set, and the field is
    // missing entirely on a default or older config. Hashing it verbatim made
    // `undefined` and `["claude"]` two different corpora, so a perfectly valid
    // verdict was discarded as "about something else" (Copilot, PR #544).
    const implicit = computeCorpusVersion({ claudeHomes: ["C:/a"] } as MinderConfig);
    const explicit = computeCorpusVersion(
      { claudeHomes: ["C:/a"], enabledAdapters: ["claude"] } as MinderConfig
    );
    expect(implicit).toBe(explicit);
  });

  it("changes when the swept set genuinely moves", () => {
    const base = computeCorpusVersion(cfg({ claudeHomes: ["C:/a"] }));
    expect(computeCorpusVersion(cfg({ claudeHomes: ["C:/a", "C:/c"] }))).not.toBe(base);
    // Adapters change what a full pass walks, so they belong in the version.
    expect(
      computeCorpusVersion(cfg({ claudeHomes: ["C:/a"], enabledAdapters: ["claude", "codex"] }))
    ).not.toBe(base);
  });
});

describe("readReconcileVerdict", () => {
  it("returns null before any pass has written one", () => {
    // "No claim", not "complete". A machine before its first index is not
    // degraded — the same rule the file sweeps follow.
    expect(readReconcileVerdict(db, "v1")).toBeNull();
  });

  it("round-trips a verdict for the same corpus", () => {
    writeReconcileVerdict(db, "v1", { incomplete: true, enumerationFailures: 3 });
    expect(readReconcileVerdict(db, "v1")).toEqual({
      incomplete: true,
      enumerationFailures: 3,
    });
  });

  it("refuses a verdict about a DIFFERENT corpus", () => {
    // Finding 2 of the five that reverted PR #527. A persisted flag needs
    // invalidation that a delete cannot give it: if a reset removes the flag
    // while a stale `aborted` run row survives, a fallback re-asserts the
    // verdict the reset just cleared. Carrying the version means a changed
    // corpus yields "no claim" without deleting anything, and nothing ever
    // falls back to `indexer_runs`.
    writeReconcileVerdict(db, "v1", { incomplete: true, enumerationFailures: 3 });
    expect(readReconcileVerdict(db, "v2")).toBeNull();
  });

  it("overwrites rather than accumulating, so the answer is the LAST pass", () => {
    writeReconcileVerdict(db, "v1", { incomplete: true, enumerationFailures: 2 });
    writeReconcileVerdict(db, "v1", { incomplete: false, enumerationFailures: 0 });
    expect(readReconcileVerdict(db, "v1")).toEqual({
      incomplete: false,
      enumerationFailures: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta").get()).toEqual({ n: 1 });
  });

  it("treats an unreadable row as no claim, never as complete", () => {
    // Malformed JSON, a missing flag, a row written by a future shape — all
    // mean "nobody told us", and guessing `complete` here would be the silent
    // wrong answer this whole issue is about.
    for (const bad of ['{"corpusVersion":"v1"}', "not json", '{"corpusVersion":"v1","incomplete":"yes"}']) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('reconcile_verdict', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = ?"
      ).run(bad, bad);
      expect(readReconcileVerdict(db, "v1")).toBeNull();
    }
  });
});
