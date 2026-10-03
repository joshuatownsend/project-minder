import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PARENT_VERIFIED_ENV,
  PARENT_VERIFIED_MAX_AGE_MS,
  _resetParentVerifiedForTesting,
  markParentVerified,
  parentVerifiedEnvFor,
  workerEnvFor,
  parentVerifiedRecently,
  shouldRunQuickCheck,
} from "@/lib/db/cleanShutdown";

import { nextWorkerEnv } from "@/lib/db/workerHost";

const BIG = 2_600_000_000;

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

  it("hands the stamp to the first spawn as explicit env, and the worker believes it", () => {
    markParentVerified(1_000);
    const env = parentVerifiedEnvFor({ now: 2_000 });
    expect(env).toEqual({ [PARENT_VERIFIED_ENV]: "1000" });
    expect(parentVerifiedRecently({ isWorkerThread: true, env, now: 2_000 })).toBe(true);
  });

  it("is never believed on the main thread", () => {
    const env: Record<string, string | undefined> = { [PARENT_VERIFIED_ENV]: "1000" };
    expect(parentVerifiedRecently({ isWorkerThread: false, env, now: 1_001 })).toBe(false);
  });

  it("expires, and rejects absent, garbage, and future stamps", () => {
    const at = 1_000_000;
    const env = { [PARENT_VERIFIED_ENV]: String(at) };
    expect(
      parentVerifiedRecently({
        isWorkerThread: true,
        env,
        now: at + PARENT_VERIFIED_MAX_AGE_MS + 1,
      }),
    ).toBe(false);
    expect(parentVerifiedRecently({ isWorkerThread: true, env: {}, now: at })).toBe(false);
    expect(
      parentVerifiedRecently({
        isWorkerThread: true,
        env: { [PARENT_VERIFIED_ENV]: "nope" },
        now: at,
      }),
    ).toBe(false);
    expect(parentVerifiedRecently({ isWorkerThread: true, env, now: at - 5 })).toBe(false);
  });

  it("is one-shot: a crash-respawn gets nothing, even if the main thread re-stamps", () => {
    markParentVerified(1_000);
    expect(parentVerifiedEnvFor({ now: 2_000 })).not.toEqual({});
    // The host's second spawn (crash-respawn) after a main-thread initDb retry:
    markParentVerified(1_500);
    expect(parentVerifiedEnvFor({ now: 2_000 })).toEqual({});
  });

  it("offers nothing when the stamp is stale or absent", () => {
    markParentVerified(1_000);
    expect(
      parentVerifiedEnvFor({ now: 1_000 + PARENT_VERIFIED_MAX_AGE_MS + 1 }),
    ).toEqual({});
    expect(parentVerifiedEnvFor({ now: 2_000 })).toEqual({}); // consumed above
  });

  it("rejects a numeric-prefix stamp that parseInt would have accepted", () => {
    const now = 5_000_000;
    for (const raw of [`${now}junk`, `${now} `, `0x10`, `${now}.5`, `-${now}`, `1e6`]) {
      expect(
        parentVerifiedRecently({
          isWorkerThread: true,
          env: { [PARENT_VERIFIED_ENV]: raw },
          now,
        }),
      ).toBe(false);
    }
    expect(
      parentVerifiedRecently({
        isWorkerThread: true,
        env: { [PARENT_VERIFIED_ENV]: String(now) },
        now,
      }),
    ).toBe(true);
  });

  it("workerEnvFor strips an ambient stamp and keeps the rest of the env", () => {
    const base = { PATH: "p", [PARENT_VERIFIED_ENV]: String(Date.now()) };
    // No parent verification pending: the ambient value must not reach a worker,
    // on the first spawn or any later one.
    for (let spawn = 0; spawn < 2; spawn++) {
      const env = workerEnvFor({ base });
      expect(env[PARENT_VERIFIED_ENV]).toBeUndefined();
      expect(env.PATH).toBe("p");
    }
  });

  it("workerEnvFor adds the real stamp for the first spawn only", () => {
    markParentVerified(1_000);
    const first = workerEnvFor({ base: { PATH: "p" }, now: 2_000 });
    expect(first[PARENT_VERIFIED_ENV]).toBe("1000");
    markParentVerified(1_500);
    expect(workerEnvFor({ base: { PATH: "p" }, now: 2_000 })[PARENT_VERIFIED_ENV]).toBeUndefined();
  });

  it("nextWorkerEnv: the first spawn gets the stamp; a crash-respawn never does, even after a re-stamp", () => {
    markParentVerified(Date.now());
    const first = nextWorkerEnv({ PATH: "p" });
    expect(first[PARENT_VERIFIED_ENV]).toMatch(/^\d+$/);
    expect(first.PATH).toBe("p");

    markParentVerified(Date.now()); // e.g. a main-thread initDb retry
    const respawn = nextWorkerEnv({ PATH: "p" });
    expect(respawn[PARENT_VERIFIED_ENV]).toBeUndefined();
  });

  // Codex P1, PR #601: the idempotent startWorker() replace path builds a FRESH
  // host state, so a per-host "already offered" flag reset and the replacement
  // worker inherited a re-stamped handoff after the old worker was force-killed.
  // The latch is process-wide, so no host state — new or old — can re-offer it.
  it("a replacement host (fresh state) cannot be handed a re-stamped handoff", () => {
    markParentVerified(Date.now());
    expect(nextWorkerEnv()[PARENT_VERIFIED_ENV]).toBeDefined(); // original host's worker
    markParentVerified(Date.now()); // main-thread initDb ran again afterwards
    // startWorker() replaces the host; nothing carries over except process state.
    expect(nextWorkerEnv()[PARENT_VERIFIED_ENV]).toBeUndefined();
  });
});
