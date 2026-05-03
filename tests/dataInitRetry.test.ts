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
  it("does NOT cache `available: false` results — next call retries initDb", async () => {
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();

    // First call: spy on initDb to simulate a transient failure
    // (EBUSY-on-rename style: the schema check failed but the DB itself
    // is healthy).
    const initSpy = vi.spyOn(mig, "initDb");
    initSpy.mockResolvedValueOnce({
      available: false,
      error: new Error("simulated EBUSY: rename failed"),
      appliedMigrations: [],
      schemaVersion: 0,
      quarantined: null,
    });

    // First façade call: DB path falls through to file (no DB available).
    const first = await facade.getUsage("all");
    expect(first.meta.backend).toBe("file");

    // initDb was called exactly once (the failure was cached for that
    // in-flight call, but cleared on resolution).
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Second façade call: must retry initDb, not return the cached
    // failure. We let the spy call the real initDb this time (no
    // additional mockResolvedValueOnce), which will succeed because the
    // `~/.minder/` directory is writable.
    const second = await facade.getUsage("all");

    // initDb called again (retry happened).
    expect(initSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Backend depends on whether the real initDb finds an empty DB —
    // either way the key assertion is the retry happened. With a fresh
    // tmpHome and no JSONL files, both backends report empty, so we
    // just assert the call was retried.
    expect(["db", "file"]).toContain(second.meta.backend);
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
