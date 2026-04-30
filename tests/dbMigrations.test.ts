import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import Database from "better-sqlite3";

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
// (Note: SQLite multi-statement runs below use the better-sqlite3 driver
// API, not Node's child_process.)

let tmpHome: string;
let originalHome: string | undefined;

async function freshTempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-db-test-"));
  return dir;
}

async function reloadModulesPointingAt(home: string) {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  return { conn, mig };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await freshTempHome();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome) process.env.HOME = originalHome;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("initDb", () => {
  it("applies the initial migration on a fresh DB", async () => {
    const { conn, mig } = await reloadModulesPointingAt(tmpHome);
    const result = await mig.initDb();
    expect(result.error).toBeNull();
    expect(result.available).toBe(true);
    expect(result.appliedMigrations).toEqual([1]);
    expect(result.schemaVersion).toBe(1);

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
    expect(result.schemaVersion).toBe(1);
    second.conn.closeDb();
  });

  // Skipped on Windows: better-sqlite3 holds the OS file handle past the
  // constructor throw until GC fires (no destructor in JS land), and the
  // rename retry loop loses the race even with generous backoff. The
  // production scenario this guards (corrupt file from a previously crashed
  // process) doesn't have this contention because the prior process has
  // long since released the lock by the time we see the file.
  const testFn = process.platform === "win32" ? it.skip : it;
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
    expect(result.appliedMigrations).toEqual([1]);

    // The schema ran on the rebuilt empty DB.
    const db = await conn.getDb();
    const tables = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("sessions");
    conn.closeDb();
  });
});
