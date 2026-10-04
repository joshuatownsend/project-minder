import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  PARENT_VERIFIED_ENV,
  PARENT_VERIFIED_ID_ENV,
  PARENT_VERIFIED_MAX_AGE_MS,
  _resetParentVerifiedForTesting,
  dbIdentity,
  markParentVerified,
  parentVerifiedEnvFor,
  workerEnvFor,
  parentVerifiedRecently,
  shouldRunQuickCheck,
} from "@/lib/db/cleanShutdown";

import { nextWorkerEnv } from "@/lib/db/workerHost";

const BIG = 2_600_000_000;
const ID = "db-A";

/** The env a worker would be handed for a stamp taken at `at` on file `id`. */
const stampEnv = (at: number, id = ID): Record<string, string> => ({
  [PARENT_VERIFIED_ENV]: String(at),
  [PARENT_VERIFIED_ID_ENV]: id,
});

// The stamp lives in process-global state and Vitest reuses workers, so another
// file's initDb() can leave one behind. Reset around every test (Copilot, #601).
beforeEach(() => _resetParentVerifiedForTesting());
afterEach(() => _resetParentVerifiedForTesting());

describe("parent-verified quick_check handoff (#588)", () => {
  it("skips the check for a worker whose parent just verified, even with no clean marker", () => {
    expect(
      shouldRunQuickCheck({ cleanShutdown: false, dbSizeBytes: BIG, verifiedByParent: true }),
    ).toBe(false);
  });

  it("never lets the handoff bypass the small-database always-check floor", () => {
    expect(
      shouldRunQuickCheck({ cleanShutdown: false, dbSizeBytes: 1_000_000, verifiedByParent: true }),
    ).toBe(true);
  });

  it("still runs when forced", () => {
    expect(
      shouldRunQuickCheck({
        cleanShutdown: false,
        dbSizeBytes: BIG,
        verifiedByParent: true,
        force: true,
      }),
    ).toBe(true);
  });

  it("runs without a parent verification (unchanged default)", () => {
    expect(shouldRunQuickCheck({ cleanShutdown: false, dbSizeBytes: BIG })).toBe(true);
  });

  it("hands the stamp and file identity to the first spawn as explicit env, and the worker believes it", () => {
    markParentVerified(1_000, ID);
    const env = parentVerifiedEnvFor({ now: 2_000 });
    expect(env).toEqual(stampEnv(1_000));
    expect(
      parentVerifiedRecently({ isWorkerThread: true, env, now: 2_000, currentDbId: ID }),
    ).toBe(true);
  });

  it("is never believed on the main thread", () => {
    expect(
      parentVerifiedRecently({
        isWorkerThread: false,
        env: stampEnv(1_000),
        now: 1_001,
        currentDbId: ID,
      }),
    ).toBe(false);
  });

  it("expires, and rejects absent, garbage, and future stamps", () => {
    const at = 1_000_000;
    const ok = (env: Record<string, string | undefined>, now: number) =>
      parentVerifiedRecently({ isWorkerThread: true, env, now, currentDbId: ID });
    expect(ok(stampEnv(at), at + PARENT_VERIFIED_MAX_AGE_MS + 1)).toBe(false);
    expect(ok({}, at)).toBe(false);
    expect(ok({ ...stampEnv(at), [PARENT_VERIFIED_ENV]: "nope" }, at)).toBe(false);
    expect(ok(stampEnv(at), at - 5)).toBe(false);
  });

  // Copilot, PR #601: a bare timestamp cannot prove the worker is opening the
  // file the parent verified.
  it("does not skip when the worker is about to open a DIFFERENT file than the parent verified", () => {
    const now = 5_000_000;
    const env = stampEnv(now, "db-A");
    expect(
      parentVerifiedRecently({ isWorkerThread: true, env, now, currentDbId: "db-A" }),
    ).toBe(true);
    expect(
      parentVerifiedRecently({ isWorkerThread: true, env, now, currentDbId: "db-B" }),
    ).toBe(false);
    // An unreadable current file never authorises a skip.
    expect(
      parentVerifiedRecently({ isWorkerThread: true, env, now, currentDbId: null }),
    ).toBe(false);
    // A stamp with no recorded identity is not believed either.
    expect(
      parentVerifiedRecently({
        isWorkerThread: true,
        env: { [PARENT_VERIFIED_ENV]: String(now) },
        now,
        currentDbId: "db-A",
      }),
    ).toBe(false);
  });

  it("records nothing, and offers nothing, when the verified file's identity is unknown", () => {
    markParentVerified(1_000, null);
    expect(parentVerifiedEnvFor({ now: 2_000 })).toEqual({});
  });

  it("is one-shot: a crash-respawn gets nothing, even if the main thread re-stamps", () => {
    markParentVerified(1_000, ID);
    expect(parentVerifiedEnvFor({ now: 2_000 })).not.toEqual({});
    // The host's second spawn (crash-respawn) after a main-thread initDb retry:
    markParentVerified(1_500, ID);
    expect(parentVerifiedEnvFor({ now: 2_000 })).toEqual({});
  });

  it("offers nothing when the stamp is stale or absent", () => {
    markParentVerified(1_000, ID);
    expect(parentVerifiedEnvFor({ now: 1_000 + PARENT_VERIFIED_MAX_AGE_MS + 1 })).toEqual({});
    expect(parentVerifiedEnvFor({ now: 2_000 })).toEqual({}); // consumed above
  });

  it("rejects a numeric-prefix stamp that parseInt would have accepted", () => {
    const now = 5_000_000;
    for (const raw of [`${now}junk`, `${now} `, `0x10`, `${now}.5`, `-${now}`, `1e6`]) {
      expect(
        parentVerifiedRecently({
          isWorkerThread: true,
          env: { ...stampEnv(now), [PARENT_VERIFIED_ENV]: raw },
          now,
          currentDbId: ID,
        }),
      ).toBe(false);
    }
    expect(
      parentVerifiedRecently({
        isWorkerThread: true,
        env: stampEnv(now),
        now,
        currentDbId: ID,
      }),
    ).toBe(true);
  });

  it("workerEnvFor strips an ambient stamp and identity and keeps the rest of the env", () => {
    const base = { PATH: "p", ...stampEnv(Date.now()) };
    // No parent verification pending: the ambient values must not reach a worker,
    // on the first spawn or any later one.
    for (let spawn = 0; spawn < 2; spawn++) {
      const env = workerEnvFor({ base });
      expect(env[PARENT_VERIFIED_ENV]).toBeUndefined();
      expect(env[PARENT_VERIFIED_ID_ENV]).toBeUndefined();
      expect(env.PATH).toBe("p");
    }
  });

  it("workerEnvFor adds the real stamp for the first spawn only", () => {
    markParentVerified(1_000, ID);
    const first = workerEnvFor({ base: { PATH: "p" }, now: 2_000 });
    expect(first[PARENT_VERIFIED_ENV]).toBe("1000");
    expect(first[PARENT_VERIFIED_ID_ENV]).toBe(ID);
    markParentVerified(1_500, ID);
    expect(workerEnvFor({ base: { PATH: "p" }, now: 2_000 })[PARENT_VERIFIED_ENV]).toBeUndefined();
  });

  it("nextWorkerEnv: the first spawn gets the stamp; a crash-respawn never does, even after a re-stamp", () => {
    markParentVerified(Date.now(), ID);
    const first = nextWorkerEnv({ PATH: "p" });
    expect(first[PARENT_VERIFIED_ENV]).toMatch(/^\d+$/);
    expect(first.PATH).toBe("p");

    markParentVerified(Date.now(), ID); // e.g. a main-thread initDb retry
    const respawn = nextWorkerEnv({ PATH: "p" });
    expect(respawn[PARENT_VERIFIED_ENV]).toBeUndefined();
  });

  // Codex P1, PR #601: the idempotent startWorker() replace path builds a FRESH
  // host state, so a per-host "already offered" flag reset and the replacement
  // worker inherited a re-stamped handoff after the old worker was force-killed.
  // The latch is process-wide, so no host state — new or old — can re-offer it.
  it("a replacement host (fresh state) cannot be handed a re-stamped handoff", () => {
    markParentVerified(Date.now(), ID);
    expect(nextWorkerEnv()[PARENT_VERIFIED_ENV]).toBeDefined(); // original host's worker
    markParentVerified(Date.now(), ID); // main-thread initDb ran again afterwards
    // startWorker() replaces the host; nothing carries over except process state.
    expect(nextWorkerEnv()[PARENT_VERIFIED_ENV]).toBeUndefined();
  });
});

describe("dbIdentity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pm-dbid-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable across writes (size and mtime change, the file does not)", () => {
    const f = path.join(dir, "index.db");
    writeFileSync(f, "one");
    const before = dbIdentity(f);
    writeFileSync(f, "two-longer-content");
    expect(before).not.toBeNull();
    expect(dbIdentity(f)).toBe(before);
  });

  it("changes when the file is replaced by a different one", () => {
    const f = path.join(dir, "index.db");
    const other = path.join(dir, "restored.db");
    writeFileSync(f, "original");
    writeFileSync(other, "restored from backup");
    const before = dbIdentity(f);
    renameSync(other, f); // restore-over: same path, different file
    expect(dbIdentity(f)).not.toBe(before);
  });

  it("is null for a file that cannot be read", () => {
    expect(dbIdentity(path.join(dir, "missing.db"))).toBeNull();
  });
});
