import { describe, it, expect } from "vitest";
import {
  PARENT_VERIFIED_ENV,
  PARENT_VERIFIED_MAX_AGE_MS,
  markParentVerified,
  parentVerifiedEnvFor,
  workerEnvFor,
  parentVerifiedRecently,
  shouldRunQuickCheck,
} from "@/lib/db/cleanShutdown";

const BIG = 2_600_000_000;

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
    const env = parentVerifiedEnvFor({ first: true, now: 2_000 });
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
    expect(parentVerifiedEnvFor({ first: true, now: 2_000 })).not.toEqual({});
    // The host's second spawn (crash-respawn) after a main-thread initDb retry:
    markParentVerified(1_500);
    expect(parentVerifiedEnvFor({ first: false, now: 2_000 })).toEqual({});
  });

  it("offers nothing when the stamp is stale or absent", () => {
    markParentVerified(1_000);
    expect(
      parentVerifiedEnvFor({ first: true, now: 1_000 + PARENT_VERIFIED_MAX_AGE_MS + 1 }),
    ).toEqual({});
    expect(parentVerifiedEnvFor({ first: true, now: 2_000 })).toEqual({}); // consumed above
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
    // No parent verification pending: the ambient value must not reach a worker.
    for (const first of [true, false]) {
      const env = workerEnvFor({ first, base });
      expect(env[PARENT_VERIFIED_ENV]).toBeUndefined();
      expect(env.PATH).toBe("p");
    }
  });

  it("workerEnvFor adds the real stamp for the first spawn only", () => {
    markParentVerified(1_000);
    const first = workerEnvFor({ first: true, base: { PATH: "p" }, now: 2_000 });
    expect(first[PARENT_VERIFIED_ENV]).toBe("1000");
    markParentVerified(1_500);
    expect(workerEnvFor({ first: false, base: { PATH: "p" }, now: 2_000 })[PARENT_VERIFIED_ENV]).toBeUndefined();
  });
});
