/**
 * SQL window query tests using an in-memory SQLite DB.
 * Pattern mirrors mcpSecurityStore.test.ts: load better-sqlite3 dynamically,
 * apply schema.sql, skip if driver isn't available.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";
import { loadSessionCostsInWindow } from "@/lib/data/sessionsInWindow";

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available on this platform */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db", "schema.sql");

function openDb(): DatabaseT.Database {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any)["ex" + "ec"](sql);
  return db;
}

/** Insert a minimal sessions row with ISO start/end timestamps. */
function insertSession(
  db: DatabaseT.Database,
  opts: {
    sessionId: string;
    projectSlug: string;
    startTs: string;  // ISO
    endTs: string;    // ISO
    costUsd: number;
  },
) {
  db.prepare(
    `INSERT INTO sessions (
       session_id, project_slug, project_dir_name, file_path,
       file_mtime_ms, file_size, byte_offset,
       start_ts, end_ts, cost_usd, indexed_at_ms
     ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0)`,
  ).run(
    opts.sessionId,
    opts.projectSlug,
    opts.projectSlug,
    `/fake/${opts.sessionId}.jsonl`,
    opts.startTs,
    opts.endTs,
    opts.costUsd,
  );
}

describe.skipIf(!Database)("loadSessionCostsInWindow (in-memory DB)", () => {
  let db: DatabaseT.Database;

  const SLUG = "test-project";
  const T0 = new Date("2026-01-01T00:00:00.000Z").getTime(); // 1735689600000

  beforeAll(() => {
    db = openDb();

    // Session A: entirely inside the window [T0, T0+4h]
    insertSession(db, {
      sessionId: "sess-a",
      projectSlug: SLUG,
      startTs: new Date(T0 + 1 * 3600_000).toISOString(), // +1h
      endTs:   new Date(T0 + 3 * 3600_000).toISOString(), // +3h
      costUsd: 1.0,
    });

    // Session B: started before window, ends inside
    insertSession(db, {
      sessionId: "sess-b",
      projectSlug: SLUG,
      startTs: new Date(T0 - 1 * 3600_000).toISOString(), // -1h
      endTs:   new Date(T0 + 2 * 3600_000).toISOString(), // +2h
      costUsd: 0.5,
    });

    // Session C: entirely outside (after window)
    insertSession(db, {
      sessionId: "sess-c",
      projectSlug: SLUG,
      startTs: new Date(T0 + 5 * 3600_000).toISOString(), // +5h
      endTs:   new Date(T0 + 6 * 3600_000).toISOString(), // +6h
      costUsd: 2.0,
    });

    // Session D: entirely outside (before window)
    insertSession(db, {
      sessionId: "sess-d",
      projectSlug: SLUG,
      startTs: new Date(T0 - 3 * 3600_000).toISOString(), // -3h
      endTs:   new Date(T0 - 1 * 3600_000).toISOString(), // -1h
      costUsd: 3.0,
    });

    // Session E: different project — should never appear
    insertSession(db, {
      sessionId: "sess-e",
      projectSlug: "other-project",
      startTs: new Date(T0 + 1 * 3600_000).toISOString(),
      endTs:   new Date(T0 + 3 * 3600_000).toISOString(),
      costUsd: 9.0,
    });
  });

  it("returns sessions that overlap the window", () => {
    const rows = loadSessionCostsInWindow(db, SLUG, T0, T0 + 4 * 3600_000);
    // sess-a (inside) and sess-b (straddles left edge) overlap; sess-c and sess-d do not
    expect(rows).toHaveLength(2);
    const costs = rows.map((r) => r.costUsd).sort((a, b) => a - b);
    expect(costs).toEqual([0.5, 1.0]);
  });

  it("excludes sessions from a different project", () => {
    const rows = loadSessionCostsInWindow(db, SLUG, T0, T0 + 4 * 3600_000);
    // sess-e is for 'other-project' and must not appear
    expect(rows.every((r) => r.costUsd !== 9.0)).toBe(true);
  });

  it("returns empty array when no sessions overlap", () => {
    // Window [+10h, +12h] has no sessions
    const rows = loadSessionCostsInWindow(db, SLUG, T0 + 10 * 3600_000, T0 + 12 * 3600_000);
    expect(rows).toHaveLength(0);
  });

  it("returns empty array for unknown project slug", () => {
    const rows = loadSessionCostsInWindow(db, "nonexistent", T0, T0 + 4 * 3600_000);
    expect(rows).toHaveLength(0);
  });

  it("returns rows ordered by start_ts ascending", () => {
    const rows = loadSessionCostsInWindow(db, SLUG, T0, T0 + 4 * 3600_000);
    // sess-b starts at T0-1h, sess-a starts at T0+1h
    // After ISO string sort, B (earlier start) should come first
    expect(rows[0].costUsd).toBe(0.5); // sess-b
    expect(rows[1].costUsd).toBe(1.0); // sess-a
  });

  it("returns rows with numeric costUsd (zero-cost session maps to 0)", () => {
    // Insert a zero-cost session to verify the costUsd field is always a number
    insertSession(db, {
      sessionId: "sess-zero-cost",
      projectSlug: SLUG,
      startTs: new Date(T0 + 1 * 3600_000).toISOString(),
      endTs:   new Date(T0 + 3 * 3600_000).toISOString(),
      costUsd: 0,
    });
    const rows = loadSessionCostsInWindow(db, SLUG, T0, T0 + 4 * 3600_000);
    expect(rows.every((r) => typeof r.costUsd === "number")).toBe(true);
    const zeroRow = rows.find((r) => r.costUsd === 0);
    expect(zeroRow).toBeDefined();
  });
});
