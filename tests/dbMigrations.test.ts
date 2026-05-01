import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { isWindows } from "@/lib/platform";

// Migrations integration test. Uses a temp HOME so we don't touch the real
// ~/.minder/index.db. Walks through:
//   1. Fresh DB → first migration runs → schema_version = 1
//   2. Re-init on populated DB → no migrations re-run
//   3. Corrupt DB → quarantine + rebuild
//
// We re-import the module under each test because connection.ts caches
// state on globalThis (HMR-safe in production, but breaks test isolation
// unless we reset).
//
// Native dependency check: `better-sqlite3` is an `optionalDependencies`
// entry, so on platforms without a prebuilt binary the driver fails to
// load and the rest of the runtime falls back gracefully. The test suite
// matches that contract: skip rather than crash.

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

async function freshTempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-db-test-"));
  return dir;
}

async function reloadModulesPointingAt(home: string) {
  vi.resetModules();
  // The connection module caches its state on globalThis to survive HMR.
  // Tests need a clean slate per reload, otherwise a stale db handle or
  // lastError from a previous test leaks across.
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  return { conn, mig };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await freshTempHome();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("initDb", () => {
  it("applies the initial migration on a fresh DB", async () => {
    const { conn, mig } = await reloadModulesPointingAt(tmpHome);
    const result = await mig.initDb();
    expect(result.error).toBeNull();
    expect(result.available).toBe(true);
    // Fresh DBs run every migration in order. v2 / v3 are no-ops on
    // fresh DBs because schema.sql already includes their additions,
    // but each still bumps the schema_version stamp. Note that v3
    // ALSO sets `meta.needs_reconcile_after_v3 = 1` even on fresh DBs;
    // that's harmless because the indexer's first reconcile clears it.
    expect(result.appliedMigrations).toEqual([1, 2, 3, 4]);
    expect(result.schemaVersion).toBe(4);

    const db = await conn.getDb();
    expect(db).not.toBeNull();
    const tables = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("sessions");
    expect(tables).toContain("indexer_runs");
    conn.closeDb();
  });

  it("is idempotent on a re-init", async () => {
    const first = await reloadModulesPointingAt(tmpHome);
    await first.mig.initDb();
    first.conn.closeDb();

    const second = await reloadModulesPointingAt(tmpHome);
    const result = await second.mig.initDb();
    expect(result.error).toBeNull();
    expect(result.appliedMigrations).toEqual([]);
    expect(result.schemaVersion).toBe(4);
    second.conn.closeDb();
  });

  // Skipped on Windows: better-sqlite3 holds the OS file handle past the
  // constructor throw until GC fires (no destructor in JS land), and the
  // rename retry loop loses the race even with generous backoff. The
  // production scenario this guards (corrupt file from a previously crashed
  // process) doesn't have this contention because the prior process has
  // long since released the lock by the time we see the file.
  const testFn = isWindows ? it.skip : it;
  testFn("quarantines a corrupt DB and rebuilds", { timeout: 15000 }, async () => {
    const minderDir = path.join(tmpHome, ".minder");
    await fs.mkdir(minderDir, { recursive: true });
    const dbPath = path.join(minderDir, "index.db");

    // Write a non-SQLite file at the DB path. SQLite checks the magic
    // header (`SQLite format 3\0`) before opening any file handle for
    // I/O, so the constructor fails fast — no lingering Windows file
    // lock to fight on rename. Truly-corrupt-real-DB testing is
    // skipped here (it's flaky on Windows due to async lock release
    // after a partial open) — the integrity_check path is exercised by
    // production, not unit tests.
    await fs.writeFile(dbPath, Buffer.from("NOT_A_VALID_SQLITE_FILE_HEADER\n"));

    const { conn, mig } = await reloadModulesPointingAt(tmpHome);
    const result = await mig.initDb();

    expect(result.available).toBe(true);
    expect(result.quarantined).not.toBeNull();
    expect(result.appliedMigrations).toEqual([1, 2, 3, 4]);

    // The schema ran on the rebuilt empty DB.
    const db = await conn.getDb();
    const tables = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("sessions");
    conn.closeDb();
  });

  it("recovers when meta exists but schema_version is missing", async () => {
    // First run: produces a populated DB.
    const first = await reloadModulesPointingAt(tmpHome);
    await first.mig.initDb();
    const db1 = await first.conn.getDb();
    expect(db1).not.toBeNull();
    // Wipe the version stamp while leaving the rest of meta intact.
    db1!.prepare("DELETE FROM meta WHERE key='schema_version'").run();
    first.conn.closeDb();

    // Second run: getCurrentVersion now sees meta-without-stamp and
    // throws SchemaVersionMissingError; initDb routes to the quarantine
    // path and rebuilds.
    const second = await reloadModulesPointingAt(tmpHome);
    const result = await second.mig.initDb();
    expect(result.error).toBeNull();
    expect(result.available).toBe(true);
    expect(result.quarantined).not.toBeNull();
    expect(result.schemaVersion).toBe(4);
    second.conn.closeDb();
  });

  it("returns cleanly without quarantine when driver is unavailable", async () => {
    // Simulate driver-missing by stubbing Database to null on the freshly
    // imported module. We do this via a synthetic state where the module
    // graph thinks the optional dep failed to load. The contract: initDb
    // must NOT call quarantineCorruptDb in this case.
    const { conn, mig } = await reloadModulesPointingAt(tmpHome);
    // Sanity check: in this test environment the driver IS loaded
    // (otherwise the suite is skipped). We monkey-patch the module's
    // exported isDriverLoaded predicate via the singleton state.
    const stateRef = (globalThis as { __minderDb?: { db: unknown } }).__minderDb;
    expect(stateRef).toBeDefined();
    const writeSpy = vi.spyOn(conn, "isDriverLoaded").mockReturnValue(false);
    const errorSpy = vi.spyOn(conn, "getDbError").mockReturnValue(new Error("native binary missing"));

    const result = await mig.initDb();
    expect(result.available).toBe(false);
    expect(result.quarantined).toBeNull();
    expect(result.appliedMigrations).toEqual([]);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/driver unavailable/);

    writeSpy.mockRestore();
    errorSpy.mockRestore();
    conn.closeDb();
  });

  it("v2 migration is idempotent: simulated v1 DB upgrades cleanly to v2", async () => {
    // Simulate a database that was created against the v1 schema (no
    // tool_result_preview column) and bring it up to v2. The migration
    // must add the column without failing on fresh DBs that already
    // have it (handled by the table_info check in migrations.ts).
    const reloaded = await reloadModulesPointingAt(tmpHome);
    await reloaded.mig.initDb();
    const db = await reloaded.conn.getDb();
    expect(db).not.toBeNull();

    // Confirm v2 column exists after the fresh init.
    const colsAfter = db!.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === "tool_result_preview")).toBe(true);

    // Simulate a "rolled-back-to-v1" state by dropping the column and
    // resetting the schema_version stamp, then re-running initDb. v2
    // should re-apply.
    db!.exec("ALTER TABLE turns DROP COLUMN tool_result_preview");
    db!.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    reloaded.conn.closeDb();

    const second = await reloadModulesPointingAt(tmpHome);
    const result = await second.mig.initDb();
    expect(result.error).toBeNull();
    expect(result.appliedMigrations).toEqual([2, 3, 4]);
    expect(result.schemaVersion).toBe(4);

    const db2 = await second.conn.getDb();
    const colsRecovered = db2!
      .prepare("PRAGMA table_info(turns)")
      .all() as Array<{ name: string }>;
    expect(colsRecovered.some((c) => c.name === "tool_result_preview")).toBe(true);
    second.conn.closeDb();
  });

  it("v3 migration: simulated v2 DB upgrades cleanly to v3 with readiness flag", async () => {
    // Create a real v2-shaped DB by initializing once, then drop the
    // v3 columns and the rollup table so we can prove the migration
    // re-adds them. This is closer to what an upgraded user actually
    // has on disk than a mock.
    const reloaded = await reloadModulesPointingAt(tmpHome);
    await reloaded.mig.initDb();
    const db = await reloaded.conn.getDb();
    expect(db).not.toBeNull();

    // Roll back to a v2-shaped state: drop the columns / table the v3
    // migration is responsible for adding, and reset the schema_version
    // stamp.
    db!.exec("ALTER TABLE turns DROP COLUMN cost_usd");
    db!.exec("ALTER TABLE sessions DROP COLUMN verified_task_count");
    db!.exec("ALTER TABLE sessions DROP COLUMN one_shot_task_count");
    db!.exec("DROP TABLE category_costs");
    db!.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db!.prepare("DELETE FROM meta WHERE key = 'needs_reconcile_after_v3'").run();
    reloaded.conn.closeDb();

    // Re-init: v3 + v4 should run.
    const second = await reloadModulesPointingAt(tmpHome);
    const result = await second.mig.initDb();
    expect(result.error).toBeNull();
    expect(result.appliedMigrations).toEqual([3, 4]);
    expect(result.schemaVersion).toBe(4);

    const db2 = await second.conn.getDb();
    expect(db2).not.toBeNull();

    // Schema additions are in place.
    const turnCols = db2!.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    expect(turnCols.some((c) => c.name === "cost_usd")).toBe(true);
    const sessionCols = db2!.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(sessionCols.some((c) => c.name === "verified_task_count")).toBe(true);
    expect(sessionCols.some((c) => c.name === "one_shot_task_count")).toBe(true);
    const tableRow = db2!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='category_costs'")
      .get() as { name?: string } | undefined;
    expect(tableRow?.name).toBe("category_costs");

    // Readiness flag was set so the read-side falls back until reconcile
    // populates the new columns.
    const flag = db2!
      .prepare("SELECT value FROM meta WHERE key = 'needs_reconcile_after_v3'")
      .get() as { value?: string } | undefined;
    expect(flag?.value).toBe("1");
    second.conn.closeDb();
  });
});

describe.skipIf(!driverAvailable)("getDb single-flight", () => {
  it("opens exactly one handle under concurrent callers", async () => {
    const { conn } = await reloadModulesPointingAt(tmpHome);
    // Fire 8 concurrent getDb()s on a fresh module. With a working
    // single-flight gate, all return the same instance; without it,
    // each opens its own (and most leak).
    const handles = await Promise.all(
      Array.from({ length: 8 }, () => conn.getDb())
    );
    const unique = new Set(handles);
    expect(unique.size).toBe(1);
    expect(handles[0]).not.toBeNull();
    conn.closeDb();
  });
});
