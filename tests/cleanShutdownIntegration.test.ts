import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, statSync } from "fs";
import path from "path";
import { installIsolatedState } from "./_helpers/isolatedState";

// Integration coverage for the quick_check skip, against a REAL better-sqlite3
// database rather than a mocked filesystem.
//
// `cleanShutdown.test.ts` covers the policy and the marker in isolation, but
// every assertion there is pure or fs-level. The thing those tests structurally
// cannot see is a TEMPORAL seam: `checkpointAndCloseDb()` records the DB file's
// size and mtime *after* closing the handle, while the next `initDb()` lets
// SQLite run its own open-time pragmas *before* the marker is read. If any of
// those pragmas bumped mtime, or left a non-empty `-wal` behind, the marker
// would never validate and the whole optimization would be a silent no-op —
// failing safe (we just run the check) but failing completely, and passing
// every unit test while doing so.
//
// `MINDER_QUICK_CHECK_MAX_BYTES` exists so this is reachable: the production
// threshold is 256 MB, and fabricating a quarter-gigabyte index per test run to
// exercise one boolean would be absurd.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({
  prefix: "pm-cleanshutdown-",
  extraGlobals: ["__usageCache", "__usageFileCache", "__sessionsCache"],
  // Threshold of 0 means "never always-check by size", so the marker alone
  // decides — which is exactly the production condition on a large index.
  env: { MINDER_USE_DB: "1", MINDER_QUICK_CHECK_MAX_BYTES: "0" },
});

let tmpHome: string;

/**
 * Watch for `PRAGMA quick_check` actually being prepared, rather than trusting
 * `InitResult.quickCheckSkipped`.
 *
 * The flag is derived from the same boolean that gates the check, so a test
 * asserting on it proves only that the gate is self-consistent — mutation
 * confirmed exactly that: forcing the check to always run left every
 * flag-based assertion green. Spying on better-sqlite3's own prototype observes
 * the pragma itself, which is the behavior anyone cares about.
 */
function watchQuickCheck() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const spy = vi.spyOn(Database.prototype, "prepare");
  return {
    get ran(): boolean {
      return spy.mock.calls.some(
        (args: unknown[]) => typeof args[0] === "string" && args[0].includes("quick_check")
      );
    },
    reset: () => spy.mockClear(),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function reloadModules() {
  await state.reload();
  return {
    mig: await import("@/lib/db/migrations"),
    conn: await import("@/lib/db/connection"),
    clean: await import("@/lib/db/cleanShutdown"),
  };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("quick_check skip — against a real database", () => {
  it("runs the check on a first-ever open (no marker yet)", async () => {
    const { mig } = await reloadModules();
    const watch = watchQuickCheck();
    const result = await mig.initDb();
    expect(result.available).toBe(true);
    // Nothing has ever closed this DB cleanly, so there is no proof to trust.
    expect(watch.ran).toBe(true);
    expect(result.quickCheckSkipped).toBe(false);
  });

  it("skips the check after a graceful close, and the marker really validates", async () => {
    // THE test this file exists for: proves the marker survives a real
    // close/reopen cycle against real SQLite, not just a synthetic stat — and
    // that the pragma genuinely does not run the second time.
    const { mig, conn, clean } = await reloadModules();
    const watch = watchQuickCheck();

    const first = await mig.initDb();
    expect(first.available).toBe(true);
    expect(watch.ran).toBe(true);
    expect(first.quickCheckSkipped).toBe(false);

    conn.checkpointAndCloseDb();

    const dbPath = path.join(tmpHome, ".minder", "index.db");
    expect(existsSync(clean.markerPathFor(dbPath))).toBe(true);
    // The independent WAL signal must agree, or the marker is moot.
    expect(clean.readCleanShutdownState(dbPath)).toEqual({
      trusted: true,
      reason: "trusted",
    });

    watch.reset();
    const second = await mig.initDb();
    expect(second.available).toBe(true);
    expect(watch.ran).toBe(false);
    expect(second.quickCheckSkipped).toBe(true);
  });

  it("runs the check again once the DB has been written to since the clean close", async () => {
    const { mig, conn, clean } = await reloadModules();
    await mig.initDb();
    conn.checkpointAndCloseDb();

    const dbPath = path.join(tmpHome, ".minder", "index.db");
    expect(clean.readCleanShutdownState(dbPath).trusted).toBe(true);

    // Simulate an unclean stop: reopen, write, and walk away without the
    // graceful path. The next open must not trust the stale marker.
    const db = await conn.getDb();
    expect(db).not.toBeNull();
    db!.prepare("CREATE TABLE IF NOT EXISTS _dirty (x INTEGER)").run();
    db!.prepare("INSERT INTO _dirty (x) VALUES (1)").run();

    expect(clean.readCleanShutdownState(dbPath).trusted).toBe(false);

    // Release the handle before the isolated-state helper tears the temp dir
    // down. It drops the global cache without closing, and on Windows an open
    // SQLite file blocks directory removal — a leaked handle here shows up as
    // flakiness in whichever test happens to run next, not as a failure here.
    // `closeDb()` rather than `checkpointAndCloseDb()`: the point of this test
    // is to leave the DB dirty, and checkpointing would write a clean marker.
    conn.closeDb();
  });

  it("honors MINDER_FORCE_QUICK_CHECK even with a valid marker", async () => {
    const { mig, conn, clean } = await reloadModules();
    await mig.initDb();
    conn.checkpointAndCloseDb();

    const dbPath = path.join(tmpHome, ".minder", "index.db");
    expect(clean.readCleanShutdownState(dbPath).trusted).toBe(true);

    process.env.MINDER_FORCE_QUICK_CHECK = "1";
    const watch = watchQuickCheck();
    try {
      const forced = await mig.initDb();
      expect(watch.ran).toBe(true);
      expect(forced.quickCheckSkipped).toBe(false);
    } finally {
      delete process.env.MINDER_FORCE_QUICK_CHECK;
    }
  });

  it("leaves the WAL drained after a graceful close", async () => {
    // The marker is only written when the WAL is confirmed drained, so if this
    // ever stopped holding, the skip would quietly never engage in production.
    const { mig, conn } = await reloadModules();
    await mig.initDb();
    conn.checkpointAndCloseDb();

    const wal = path.join(tmpHome, ".minder", "index.db-wal");
    if (existsSync(wal)) {
      expect(statSync(wal).size).toBe(0);
    }
  });
});
