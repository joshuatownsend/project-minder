import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Tests for the prepared-statement cache wired into `connection.ts`.
// Verifies three properties the SQL read paths depend on:
//   1. Same SQL → same Statement (identity, not just equality).
//   2. Different SQL → different Statements (the cache is keyed correctly).
//   3. closeDb()-then-reopen produces a fresh cache (no stale Statements
//      pinned to a closed DB handle).
//
// We also assert that foreign db handles bypass the cache so a test that
// constructs its own `Database` doesn't leak Statements onto the
// singleton's cache.
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
// Track the singleton's connection module across reloadModules() calls
// so afterEach can close the open db handle. Without this, the global
// state's db handle leaks past the `delete globalThis.__minderDb` reset
// — fine on POSIX (eventually GC'd) but on Windows the open .db file
// can block `fs.rm(tmpHome, …)` from removing the tempdir.
let activeConn: typeof import("@/lib/db/connection") | null = null;

async function reloadModules() {
  // Close any previously-opened singleton before resetting modules so
  // its file handle is released before we delete the global state.
  if (activeConn) {
    activeConn.closeDb();
    activeConn = null;
  }
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  activeConn = conn;
  return { conn, mig };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-prep-cache-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  if (activeConn) {
    activeConn.closeDb();
    activeConn = null;
  }
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

describe.skipIf(!driverAvailable)("prepCached", () => {
  it("returns the same Statement instance for the same SQL", async () => {
    const { conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sql = "SELECT 1 AS one";
    const a = conn.prepCached(db, sql);
    const b = conn.prepCached(db, sql);

    expect(a).toBe(b);
    expect(conn.preparedCacheSize()).toBe(1);
    expect((a.get() as { one: number }).one).toBe(1);
  });

  it("returns different Statements for different SQL", async () => {
    const { conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const a = conn.prepCached(db, "SELECT 1 AS x");
    const b = conn.prepCached(db, "SELECT 2 AS x");

    expect(a).not.toBe(b);
    expect((a.get() as { x: number }).x).toBe(1);
    expect((b.get() as { x: number }).x).toBe(2);
    expect(conn.preparedCacheSize()).toBe(2);
  });

  it("clears the cache on closeDb() and starts fresh on the next open", async () => {
    const { conn, mig } = await reloadModules();
    await mig.initDb();
    const db1 = (await conn.getDb())!;

    conn.prepCached(db1, "SELECT 1");
    conn.prepCached(db1, "SELECT 2");
    expect(conn.preparedCacheSize()).toBe(2);

    conn.closeDb();
    expect(conn.preparedCacheSize()).toBe(0);

    const db2 = (await conn.getDb())!;
    expect(db2).not.toBe(db1);
    // Same SQL after reopen — cache misses, prepares against the new
    // handle, doesn't return a stale Statement bound to the old one.
    const stmt = conn.prepCached(db2, "SELECT 1");
    expect((stmt.get() as { 1: number })).toBeDefined();
    expect(conn.preparedCacheSize()).toBe(1);
  });

  it("bypasses the cache for foreign db handles (test isolation)", async () => {
    const { conn, mig } = await reloadModules();
    await mig.initDb();
    // Open a second, independent handle directly via better-sqlite3 —
    // simulating a test that constructs its own Database.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const foreign = new Database(":memory:");
    try {
      const sql = "SELECT 7 AS n";
      const a = conn.prepCached(foreign, sql);
      const b = conn.prepCached(foreign, sql);
      // Foreign handle: cache is bypassed → distinct Statement objects.
      expect(a).not.toBe(b);
      expect((a.get() as { n: number }).n).toBe(7);
      // The singleton's cache stays untouched.
      expect(conn.preparedCacheSize()).toBe(0);
    } finally {
      foreign.close();
    }
  });
});
