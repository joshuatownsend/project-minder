import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Test for `ensureSchemaReady`'s failure-recovery contract: a transient
// `initDb()` failure (e.g. EBUSY on the corruption-quarantine rename
// during ingest write contention) must NOT poison every subsequent
// DB-backed read for the rest of the process. The original behavior
// cached the failed promise forever; this test pins the new contract
// that the cache only holds successful inits.
//
// **P2b-9 update**: when DB mode is requested and init fails, the
// façade now THROWS `DbUnavailableError` (no silent fall-through to
// file-parse). The retry-on-failure contract is still pinned here:
// the second call must re-attempt `initDb()` rather than returning
// the cached failure.
//
// Skipped when better-sqlite3 isn't loadable.

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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-init-retry-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
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

describe.skipIf(!driverAvailable)("data façade — ensureSchemaReady retry on failure", () => {
  it("caches an init failure for 30s, then retries on the next call", async () => {
    // Wave 1.2 contract: P2c cleared the cache on every failure (so
    // every dashboard poll re-ran `initDb()` end-to-end during a real
    // outage). The new contract caches the failure result for 30s and
    // serves it back to subsequent callers in that window — then
    // expires the cache so a recovered DB picks up on the next call.
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const initSpy = vi.spyOn(mig, "initDb");
    initSpy.mockResolvedValueOnce({
      available: false,
      error: new Error("simulated EBUSY: rename failed"),
      appliedMigrations: [],
      schemaVersion: 0,
      quarantined: null,
    });

    // First call: init fails → throws DbUnavailableError. initDb ran 1×.
    await expect(facade.getUsage("all")).rejects.toMatchObject({
      name: "DbUnavailableError",
      reason: "init-failed",
    });
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Second call within the 30s TTL: must NOT re-run initDb. The
    // cached failure is reused so a real outage doesn't hammer the DB
    // layer on every poll. Caller still gets DbUnavailableError.
    await expect(facade.getUsage("all")).rejects.toMatchObject({
      name: "DbUnavailableError",
      reason: "init-failed",
    });
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Advance past the 30s TTL → next call re-attempts initDb. The
    // unmocked initDb succeeds against the writable tmpHome; with no
    // JSONL files the empty index makes the façade fall back to
    // file-parse (intentional empty-index fall-through). Either
    // backend is acceptable — what we're pinning is that the retry
    // happened.
    vi.advanceTimersByTime(31_000);
    const third = await facade.getUsage("all");
    expect(initSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(["db", "file"]).toContain(third.meta.backend);

    vi.useRealTimers();
  });

  it("rethrows a thrown v3-readiness gate as DbUnavailableError(reason: 'load-failed')", async () => {
    // Codex P2 finding on PR #57: `needsReconcileAfterV3(db)` runs a
    // small SELECT and was previously called outside any wrapper. If
    // that SELECT throws (corrupt/partial meta table, stale handle),
    // the exception escaped as a raw Error not DbUnavailableError —
    // breaking the typed-failure contract for getUsage /
    // getSessionDetail / getSessionsList / getClaudeUsage. Pin the
    // wrapping here.
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();

    // Initialize the DB normally so getReadyDb() succeeds.
    await mig.initDb();

    // Replace `needsReconcileAfterV3` with a throwing stub. The
    // import path mirrors what `src/lib/data/index.ts` uses, so the
    // mock applies to the same module instance.
    const usageFromDb = await import("@/lib/data/usageFromDb");
    vi.spyOn(usageFromDb, "needsReconcileAfterV3").mockImplementation(() => {
      throw new Error("simulated stale-handle SELECT failure");
    });

    await expect(facade.getUsage("all")).rejects.toMatchObject({
      name: "DbUnavailableError",
      reason: "load-failed",
    });
  });

  it("rethrows a rejected initDb() as DbUnavailableError(reason: 'init-failed')", async () => {
    // Both reviewers (Codex P2 + Copilot) flagged this gap on PR #57:
    // `initDb()` can both resolve `{available:false}` AND REJECT (e.g.
    // a `quarantineCorruptDb` throw on Windows EBUSY). The contract says
    // every DB-unavailability under MINDER_USE_DB=1 surfaces as
    // `DbUnavailableError`; a rejection escaping as a raw `Error`
    // breaks pattern-matching callers/tests. Pin the contract here so
    // the next refactor can't quietly regress it.
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();

    const initSpy = vi.spyOn(mig, "initDb");
    initSpy.mockRejectedValueOnce(new Error("simulated quarantineCorruptDb throw"));

    await expect(facade.getUsage("all")).rejects.toMatchObject({
      name: "DbUnavailableError",
      reason: "init-failed",
    });
  });

  it("caches the in-flight init promise so concurrent first calls share one initDb invocation", async () => {
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();

    // Real initDb resolves true on a fresh tmpHome — no spy override
    // needed. Wrap to count invocations.
    const initSpy = vi.spyOn(mig, "initDb");

    // Fire two concurrent calls before either resolves.
    const [a, b] = await Promise.all([facade.getUsage("all"), facade.getUsage("all")]);

    // Both should succeed (empty corpus, both backends agree on zeros).
    expect(a.meta.backend).toBeDefined();
    expect(b.meta.backend).toBeDefined();

    // initDb called exactly once across the two concurrent calls —
    // the cached promise served the second caller during the in-flight
    // window. This is the sharing guarantee the cache was always meant
    // to provide; the failure-recovery fix must not regress it.
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});
