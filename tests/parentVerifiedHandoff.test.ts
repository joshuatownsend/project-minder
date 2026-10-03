import { describe, it, expect } from "vitest";
import {
  PARENT_VERIFIED_ENV,
  PARENT_VERIFIED_MAX_AGE_MS,
  markParentVerified,
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

  it("markParentVerified writes the timestamp the worker reads", () => {
    const env: Record<string, string | undefined> = {};
    markParentVerified(env, 1_000);
    expect(env[PARENT_VERIFIED_ENV]).toBe("1000");
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
});
