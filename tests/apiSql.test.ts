import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { NextRequest } from "next/server";

// Integration test for /api/sql against a tmpHome SQLite index.
// Uses the real route handler (not a mock); spins up a fresh DB,
// runs the v1+v2 migrations, populates a couple of rows, and asserts
// the route's contract end-to-end.
//
// Skipped if better-sqlite3 isn't loadable (matches the rest of the
// db test suite).

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

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const route = await import("@/app/api/sql/route");
  return { conn, mig, route };
}

function mkGet(sql: string): NextRequest {
  const url = `http://localhost/api/sql?sql=${encodeURIComponent(sql)}`;
  return new NextRequest(url);
}

function mkPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/sql", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sql-route-"));
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

describe.skipIf(!driverAvailable)("/api/sql", () => {
  async function setupPopulatedDb() {
    const { conn, mig, route } = await reloadModules();
    await mig.initDb();
    const db = await conn.getDb();
    if (!db) throw new Error("DB failed to open");
    db.prepare(
      `INSERT INTO sessions
       (session_id, project_dir_name, file_path, file_mtime_ms, file_size, byte_offset, derived_version, indexed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("s1", "proj-a", "/tmp/s1.jsonl", 1, 100, 0, 1, Date.now());
    db.prepare(
      `INSERT INTO sessions
       (session_id, project_dir_name, file_path, file_mtime_ms, file_size, byte_offset, derived_version, indexed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("s2", "proj-b", "/tmp/s2.jsonl", 2, 200, 0, 1, Date.now());
    return route;
  }

  it("returns row count from a populated DB", async () => {
    const route = await setupPopulatedDb();
    const res = await route.GET(mkGet("SELECT COUNT(*) AS n FROM sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(1);
    expect(body.rows[0].n).toBe(2);
    expect(body.columns).toContain("n");
    expect(body.truncated).toBe(false);
    expect(typeof body.durationMs).toBe("number");
  });

  it("rejects non-SELECT statements with 400 (regex layer)", async () => {
    const route = await setupPopulatedDb();
    const res = await route.GET(mkGet("DELETE FROM sessions"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only SELECT/i);
  });

  it("rejects DROP / CREATE / ATTACH / PRAGMA writes", async () => {
    const route = await setupPopulatedDb();
    for (const sql of [
      "DROP TABLE sessions",
      "CREATE TABLE foo(id INT)",
      "ATTACH DATABASE 'evil.db' AS evil",
      "PRAGMA journal_mode = OFF",
      "INSERT INTO sessions(session_id) VALUES ('x')",
      "UPDATE sessions SET project_dir_name = 'x'",
      "VACUUM",
    ]) {
      const res = await route.GET(mkGet(sql));
      expect(res.status, `expected 400 for: ${sql}`).toBe(400);
    }
  });

  it("accepts WITH … SELECT (CTEs)", async () => {
    const route = await setupPopulatedDb();
    const res = await route.GET(
      mkGet("WITH s AS (SELECT * FROM sessions) SELECT COUNT(*) AS n FROM s")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows[0].n).toBe(2);
  });

  it("returns 400 with SQLite message on malformed SQL", async () => {
    const route = await setupPopulatedDb();
    const res = await route.GET(mkGet("SELECT * FROM nope_no_table"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no such table/i);
  });

  it("clamps results to MAX_ROWS and reports truncated=true", async () => {
    const route = await setupPopulatedDb();
    // Use a recursive CTE to generate MAX_ROWS + 1 rows. Bound is
    // derived from the route's exported constant so this test stays
    // honest if MAX_ROWS ever changes.
    const sql = `
      WITH RECURSIVE cnt(x) AS (
        SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < ${route.MAX_ROWS + 1}
      )
      SELECT x FROM cnt
    `;
    const res = await route.GET(mkGet(sql));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(route.MAX_ROWS);
    expect(body.truncated).toBe(true);
  });

  it("rejects POST params that aren't an array or plain object", async () => {
    const route = await setupPopulatedDb();
    // Hand-craft a POST whose body parses to a Date-shaped object
    // (which JSON parses into a plain object actually, so we instead
    // test the typeof-mismatch cases the validator should reject).
    for (const bad of [42, "string-not-allowed", true]) {
      const res = await route.POST(
        mkPost({ sql: "SELECT 1 AS one", params: bad })
      );
      expect(res.status, `expected 400 for params=${JSON.stringify(bad)}`).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/array or plain object/);
    }
  });

  it("supports POST with bound parameters (positional)", async () => {
    const route = await setupPopulatedDb();
    const res = await route.POST(
      mkPost({
        sql: "SELECT session_id FROM sessions WHERE project_dir_name = ?",
        params: ["proj-a"],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(1);
    expect(body.rows[0].session_id).toBe("s1");
  });

  it("supports POST with named parameters", async () => {
    const route = await setupPopulatedDb();
    const res = await route.POST(
      mkPost({
        sql: "SELECT session_id FROM sessions WHERE project_dir_name = $proj",
        params: { proj: "proj-b" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(1);
    expect(body.rows[0].session_id).toBe("s2");
  });

  it("returns 400 on missing 'sql' param (GET)", async () => {
    const route = await setupPopulatedDb();
    const res = await route.GET(new NextRequest("http://localhost/api/sql"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed POST body", async () => {
    const route = await setupPopulatedDb();
    const res = await route.POST(mkPost("not json"));
    expect(res.status).toBe(400);
  });

  it("returns 503 when better-sqlite3 driver is unavailable", async () => {
    const { conn, route } = await reloadModules();
    vi.spyOn(conn, "isDriverLoaded").mockReturnValue(false);
    const res = await route.GET(mkGet("SELECT 1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("db unavailable");
    expect(body.reason).toMatch(/binary/);
  });

  it("auto-initializes schema on first call (no prior initDb)", async () => {
    // Cold start: tmpHome has no ~/.minder/index.db. The route must run
    // initDb() itself rather than letting `getDb()` open an empty DB and
    // fall into the 400 'no such table' path. Verifies the schema-
    // readiness gate calls initDb on first request.
    const { route } = await reloadModules();
    const res = await route.GET(mkGet("SELECT COUNT(*) AS n FROM sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Empty schema, but the table exists — count is 0 rather than a
    // 'no such table' error.
    expect(body.rows[0].n).toBe(0);
  });

  it("returns 503 when initDb reports the schema is unavailable", async () => {
    // Drive the `init.available === false` branch: the driver loaded but
    // initDb couldn't bring the schema up (e.g. corrupt rebuild loop,
    // permissions). Should surface as 503 'db unavailable' so the UI can
    // distinguish 'indexer hasn't run' from 'your query is wrong.'
    const { mig, route } = await reloadModules();
    vi.spyOn(mig, "initDb").mockResolvedValue({
      available: false,
      appliedMigrations: [],
      schemaVersion: 0,
      quarantined: null,
      error: new Error("simulated init failure"),
    });
    const res = await route.GET(mkGet("SELECT 1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("db unavailable");
    expect(body.reason).toMatch(/simulated init failure/);
  });
});
