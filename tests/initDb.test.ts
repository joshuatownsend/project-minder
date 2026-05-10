import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// `ensureSchemaReady()` state-machine contract. The companion file
// `dataInitRetry.test.ts` pins legacy contract preserved across the
// refactor (concurrent share, typed errors, post-TTL retry). This file
// pins:
//
//   - a single transient failure (EBUSY) recovers via internal retry
//     and never surfaces to the caller.
//   - the retry budget is bounded (4 attempts) — exhausting it caches
//     as `transient-failed` for 30 s.
//   - two cumulative quarantine observations flip `permanent-failed`
//     (sticky until process exit).
//   - `getInitStatus()` returns the right shape across transitions and
//     is callable without provoking a fresh init attempt.
//
// Skipped when better-sqlite3 isn't loadable (matches sibling tests).

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalUseDb: string | undefined;

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __sessionsCache?: unknown }).__sessionsCache;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    facade: await import("@/lib/data"),
    mig: await import("@/lib/db/migrations"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-init-state-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MINDER_USE_DB = "1";
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalUseDb === undefined) delete process.env.MINDER_USE_DB;
  else process.env.MINDER_USE_DB = originalUseDb;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("ensureSchemaReady — state machine", () => {
  it("recovers from a single transient EBUSY without surfacing the failure", async () => {
    // Phase-1 motivating bug: prior cache surfaced ANY init failure for
    // 30 s. A single Windows EBUSY during ingest write contention
    // therefore downgraded every dashboard read for the next 30 s. The
    // state machine must now retry transient errors internally and
    // succeed on attempt 2.
    const { facade, mig } = await reloadModules();
    facade.__setRetryDelaysForTests([0, 0, 0]);
    try {
      const initSpy = vi.spyOn(mig, "initDb");
      // First attempt fails with EBUSY in the message (no `.code`
      // attribute — exercises the substring classifier path); second
      // attempt is unmocked → real initDb against the writable
      // tmpHome → succeeds.
      initSpy.mockResolvedValueOnce({
        available: false,
        error: new Error("simulated EBUSY on rename"),
        appliedMigrations: [],
        schemaVersion: 0,
        quarantined: null,
      });

      // No throw — the retry succeeded transparently. Empty corpus
      // means file-parse fallback is acceptable; the contract being
      // pinned is "did NOT propagate the transient failure."
      const result = await facade.getUsage("all");
      expect(["db", "file"]).toContain(result.meta.backend);

      // initDb invoked twice: the failed attempt + the successful retry.
      expect(initSpy).toHaveBeenCalledTimes(2);

      // State machine should be in success terminal state.
      const status = facade.getInitStatus();
      expect(status.state).toBe("success");
      expect(status.attempts).toBe(2);
    } finally {
      facade.__setRetryDelaysForTests(null);
    }
  });

  it("flips to permanent-failed after two cumulative quarantine observations", async () => {
    // Spec: a single SQLITE_CORRUPT triggers an internal quarantine +
    // rebuild (handled inside initDb). If quarantine runs accumulate
    // to 2 across the state machine's lifetime, we declare permanent
    // failure — repeated rebuilds aren't recovering, so retrying
    // further is wasted work.
    const { facade, mig } = await reloadModules();
    facade.__setRetryDelaysForTests([0, 0, 0]);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const initSpy = vi.spyOn(mig, "initDb");
      const corruptResult = (path: string) => ({
        available: false as const,
        error: new Error("rebuild failed post-quarantine"),
        appliedMigrations: [],
        schemaVersion: 0,
        quarantined: path,
      });
      // Two scenario rounds, each returning a quarantined-but-still-
      // failing result. After round 1 → transient-failed (count=1).
      // After round 2 (post-TTL) → permanent-failed (count=2).
      initSpy.mockResolvedValue(corruptResult("/tmp/index.db.corrupt-1"));

      // Round 1.
      await expect(facade.getUsage("all")).rejects.toMatchObject({
        name: "DbUnavailableError",
        reason: "init-failed",
      });
      let status = facade.getInitStatus();
      expect(status.state).toBe("transient-failed");
      expect(status.quarantineRuns).toBe(1);

      // Cached failure during TTL: no new initDb call.
      const callsAfterRound1 = initSpy.mock.calls.length;
      await expect(facade.getUsage("all")).rejects.toMatchObject({
        name: "DbUnavailableError",
      });
      expect(initSpy.mock.calls.length).toBe(callsAfterRound1);

      // Round 2: advance past TTL, second quarantine flips permanent.
      initSpy.mockResolvedValue(corruptResult("/tmp/index.db.corrupt-2"));
      vi.advanceTimersByTime(31_000);
      await expect(facade.getUsage("all")).rejects.toMatchObject({
        name: "DbUnavailableError",
        reason: "init-failed",
      });
      status = facade.getInitStatus();
      expect(status.state).toBe("permanent-failed");
      expect(status.quarantineRuns).toBe(2);

      // Permanent is sticky: even past 30 s, no new initDb call.
      const callsAfterRound2 = initSpy.mock.calls.length;
      vi.advanceTimersByTime(120_000);
      await expect(facade.getUsage("all")).rejects.toMatchObject({
        name: "DbUnavailableError",
      });
      expect(initSpy.mock.calls.length).toBe(callsAfterRound2);
    } finally {
      vi.useRealTimers();
      facade.__setRetryDelaysForTests(null);
    }
  });

  it("getInitStatus reports idle before first call and success after a healthy init", async () => {
    const { facade } = await reloadModules();
    expect(facade.getInitStatus()).toMatchObject({
      state: "idle",
      attempts: 0,
      quarantineRuns: 0,
      failedAt: null,
      lastError: null,
    });

    // Drive a successful init via the real path against the writable
    // tmpHome — one call, attempts=1, state=success.
    facade.__setRetryDelaysForTests([0, 0, 0]);
    try {
      await facade.getUsage("all");
      const status = facade.getInitStatus();
      expect(status.state).toBe("success");
      expect(status.attempts).toBe(1);
      expect(status.quarantineRuns).toBe(0);
      expect(status.failedAt).toBeNull();
      expect(status.lastError).toBeNull();
    } finally {
      facade.__setRetryDelaysForTests(null);
    }
  });

  it("exhausts the retry budget at 4 attempts before caching", async () => {
    // Pins the budget itself, separately from the cache TTL. 4 attempts
    // = initial + 3 retries; after that the loop must stop.
    const { facade, mig } = await reloadModules();
    facade.__setRetryDelaysForTests([0, 0, 0]);
    try {
      const initSpy = vi.spyOn(mig, "initDb");
      // All-fail mock — every attempt returns a transient EBUSY-like
      // failure so the loop exhausts the retry budget.
      initSpy.mockResolvedValue({
        available: false,
        error: new Error("EBUSY: simulated lock contention"),
        appliedMigrations: [],
        schemaVersion: 0,
        quarantined: null,
      });

      await expect(facade.getUsage("all")).rejects.toMatchObject({
        name: "DbUnavailableError",
        reason: "init-failed",
      });
      // Exactly 4 attempts: initial + 3 retries (delays 100/300/900).
      expect(initSpy).toHaveBeenCalledTimes(4);

      const status = facade.getInitStatus();
      expect(status.state).toBe("transient-failed");
      expect(status.attempts).toBe(4);
    } finally {
      facade.__setRetryDelaysForTests(null);
    }
  });
});
