import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

// Schema smoke test: round-trip every table to validate constraints, FK
// cascades, and FTS5 trigger sync. Runs against an in-memory DB so it
// doesn't touch ~/.minder/index.db.
//
// `better-sqlite3` is an optional dependency: load it dynamically and
// skip the suite when the native binary isn't installed for this
// platform. (Note: db.exec below is the better-sqlite3 multi-statement
// API, not Node's child_process.exec. No shell, no injection surface.)

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available — describe.skipIf handles below */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db", "schema.sql");

function open() {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(sql);
  return db;
}

describe.skipIf(!Database)("schema.sql", () => {
  let db: DatabaseT.Database;
  beforeAll(() => {
    db = open();
  });

  it("creates all expected tables and FTS virtual tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const expected of [
      "meta", "sessions", "turns", "tool_uses", "file_edits", "daily_costs",
      "agents", "skills", "commands", "mcp_servers", "otel_events", "indexer_runs",
      "mcp_scan_runs", "mcp_scan_findings", "mcp_tool_fingerprints",
      "prompts_fts", "catalog_fts",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("enforces sessions.status CHECK constraint", () => {
    const insertBad = () => {
      db.prepare(
        "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms, status) " +
          "VALUES ('s1', 'd', '/p1', 0, 0, 0, 'NOT_A_VALID_STATUS')"
      ).run();
    };
    expect(insertBad).toThrow(/CHECK constraint failed/);
  });

  it("enforces turns.role CHECK constraint", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('s2', 'd', '/p2', 0, 0, 0)"
    ).run();
    expect(() =>
      db.prepare(
        "INSERT INTO turns (session_id, turn_index, ts, role) VALUES ('s2', 0, '2026-01-01', 'system')"
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces tool_uses.file_op CHECK constraint", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('s3', 'd', '/p3', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role) VALUES ('s3', 0, '2026-01-01', 'assistant')"
    ).run();
    expect(() =>
      db.prepare(
        "INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_name, file_op) " +
          "VALUES ('s3', 0, 0, 'Edit', 'invalid')"
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it("cascades sessions → turns → tool_uses on delete", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('cascade', 'd', '/cascade', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role) VALUES ('cascade', 0, '2026-01-01', 'assistant')"
    ).run();
    db.prepare(
      "INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_name) VALUES ('cascade', 0, 0, 'Bash')"
    ).run();
    db.prepare(
      "INSERT INTO file_edits (session_id, turn_index, file_path, op, ts) VALUES ('cascade', 0, '/x.ts', 'edit', '2026-01-01')"
    ).run();

    db.prepare("DELETE FROM sessions WHERE session_id = 'cascade'").run();

    const turns = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'cascade'").get() as { n: number };
    const tools = db.prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'cascade'").get() as { n: number };
    const edits = db.prepare("SELECT COUNT(*) AS n FROM file_edits WHERE session_id = 'cascade'").get() as { n: number };
    expect(turns.n).toBe(0);
    expect(tools.n).toBe(0);
    expect(edits.n).toBe(0);
  });

  it("two unidentified tool_uses in the same turn don't collide on PK", () => {
    // The corrected PK (session_id, turn_index, sequence_in_turn) makes this
    // legal where the original COALESCE(tool_use_id, '') design would not.
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('seq', 'd', '/seq', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role) VALUES ('seq', 0, '2026-01-01', 'assistant')"
    ).run();
    db.prepare(
      "INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_name) VALUES ('seq', 0, 0, 'Bash')"
    ).run();
    db.prepare(
      "INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_name) VALUES ('seq', 0, 1, 'Bash')"
    ).run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'seq'").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("prompts_fts is NOT trigger-populated — the writer owns it (schema v19)", () => {
    // Inverts the previous assertion deliberately. `turns_ai` / `turns_au`
    // mirrored `turns.text_preview` into prompts_fts; they were dropped
    // because they cannot express full-body indexing — the full text is
    // never stored in `turns` for a trigger to read, only the 500-char
    // preview is. `writeSession` / `appendSessionTail` now chunk the
    // parsed JSONL and insert FTS rows themselves.
    //
    // Pinning the ABSENCE matters: if a trigger were ever re-added, every
    // turn would gain a duplicate 500-char FTS row alongside its real
    // chunks, and bm25's length normalization would quietly skew ranking
    // toward the short duplicates. That failure is invisible without this
    // test.
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('fts', 'd', '/fts', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role, text_preview) " +
        "VALUES ('fts', 0, '2026-01-01', 'user', 'fix the migration bug')"
    ).run();
    expect(
      db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'migration'").all().length
    ).toBe(0);

    // An UPDATE of the mirrored columns must likewise do nothing — a
    // re-derive pass no longer churns FTS rows for unchanged text.
    db.prepare("UPDATE turns SET text_preview = 'all done' WHERE session_id = 'fts' AND turn_index = 0").run();
    expect(db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'done'").all().length).toBe(0);

    // The writer's own insert shape works and carries chunk_index.
    db.prepare(
      "INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text) " +
        "VALUES ('fts', 0, 0, 'user', '2026-01-01', 'fix the migration bug')"
    ).run();
    const rows = db
      .prepare(
        "SELECT session_id, turn_index, chunk_index FROM prompts_fts WHERE prompts_fts MATCH 'migration'"
      )
      .all() as Array<{ session_id: string; turn_index: number; chunk_index: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].chunk_index).toBe(0);
  });

  it("prompts_fts stores one row per chunk, so a turn may have several", () => {
    // The shape readers must account for: `sessionSearch.ts` collapses
    // chunks with `MIN(rank) ... GROUP BY session_id`. A reader that
    // forgot would return one hit per chunk and let a single long session
    // flood the result list.
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('multi', 'd', '/m', 0, 0, 0)"
    ).run();
    const ins = db.prepare(
      "INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text) VALUES (?, ?, ?, ?, ?, ?)"
    );
    ins.run("multi", 0, 0, "assistant", "2026-01-01", "shared marker first part");
    ins.run("multi", 0, 1, "assistant", "2026-01-01", "shared marker second part");

    const all = db.prepare("SELECT chunk_index FROM prompts_fts WHERE prompts_fts MATCH 'marker'").all();
    expect(all.length).toBe(2);

    const grouped = db
      .prepare(
        "SELECT session_id FROM (SELECT session_id, rank FROM prompts_fts WHERE prompts_fts MATCH 'marker') GROUP BY session_id"
      )
      .all();
    expect(grouped.length).toBe(1);
  });

  it("DELETE on turns does NOT auto-clean prompts_fts (writer's responsibility)", () => {
    // The `turns_ad` AFTER DELETE trigger was dropped in migration v4
    // because it scanned `prompts_fts` per cascade-deleted turn (filtering
    // on UNINDEXED columns). The writer (`writeSession` and the
    // reconcileAllSessions prune loop) is now responsible for bulk-
    // deleting prompts_fts rows for the session in one scan before the
    // cascade — see ingest.ts. This test pins that contract so a future
    // re-add of the trigger is a deliberate decision, not a regression.
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('orphan', 'd', '/o', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role, text_preview) " +
        "VALUES ('orphan', 0, '2026-01-01', 'user', 'orphan needle text')"
    ).run();
    // Seed the FTS row the way the writer does. As of schema v19 there is
    // no INSERT trigger to do it — see the test above.
    db.prepare(
      "INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text) " +
        "VALUES ('orphan', 0, 0, 'user', '2026-01-01', 'orphan needle text')"
    ).run();
    db.prepare("DELETE FROM turns WHERE session_id = 'orphan' AND turn_index = 0").run();
    // The FTS row remains because no trigger handled the delete.
    const stranded = db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'needle'").all();
    expect(stranded.length).toBe(1);

    // The bulk-by-session pattern the writer uses cleans correctly.
    db.prepare("DELETE FROM prompts_fts WHERE session_id = 'orphan'").run();
    const cleaned = db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'needle'").all();
    expect(cleaned.length).toBe(0);
  });

  it("FTS5 trigger keeps catalog_fts in sync with each catalog table", () => {
    db.prepare(
      "INSERT INTO agents (id, name, source, body_path, file_mtime_ms, file_size, indexed_at_ms, description, body_excerpt) " +
        "VALUES ('a1', 'reviewer', 'user', '/a.md', 0, 0, 0, 'reviews code carefully', 'sample body')"
    ).run();
    const hit = db.prepare("SELECT kind FROM catalog_fts WHERE catalog_fts MATCH 'reviewer'").get() as { kind: string };
    expect(hit.kind).toBe("agent");

    db.prepare(
      "INSERT INTO skills (id, name, source, body_path, file_mtime_ms, file_size, indexed_at_ms, description) " +
        "VALUES ('s1', 'planmode', 'user', '/s.md', 0, 0, 0, 'plans a task in detail')"
    ).run();
    const skillHit = db.prepare("SELECT kind FROM catalog_fts WHERE catalog_fts MATCH 'planmode'").get() as { kind: string };
    expect(skillHit.kind).toBe("skill");

    db.prepare("DELETE FROM agents WHERE id = 'a1'").run();
    const gone = db.prepare("SELECT 1 FROM catalog_fts WHERE kind = 'agent' AND id = 'a1'").all();
    expect(gone.length).toBe(0);
  });

  it("daily_costs ON CONFLICT DO UPDATE accumulates correctly", () => {
    db.prepare(
      "INSERT INTO daily_costs (day, project_slug, model, cost_usd, turn_count, session_count) " +
        "VALUES ('2026-04-30', 'pm', 'sonnet', 0.10, 5, 1) " +
        "ON CONFLICT(day, project_slug, model) DO UPDATE SET " +
        "cost_usd = cost_usd + excluded.cost_usd, turn_count = turn_count + excluded.turn_count"
    ).run();
    db.prepare(
      "INSERT INTO daily_costs (day, project_slug, model, cost_usd, turn_count, session_count) " +
        "VALUES ('2026-04-30', 'pm', 'sonnet', 0.05, 3, 1) " +
        "ON CONFLICT(day, project_slug, model) DO UPDATE SET " +
        "cost_usd = cost_usd + excluded.cost_usd, turn_count = turn_count + excluded.turn_count"
    ).run();
    const row = db
      .prepare("SELECT cost_usd, turn_count FROM daily_costs WHERE day='2026-04-30' AND project_slug='pm' AND model='sonnet'")
      .get() as { cost_usd: number; turn_count: number };
    expect(row.cost_usd).toBeCloseTo(0.15, 5);
    expect(row.turn_count).toBe(8);
  });

  it("indexer_runs accepts a heartbeat and reports last run", () => {
    db.prepare(
      "INSERT INTO indexer_runs (started_at_ms, kind, files_seen, files_changed, rows_written) VALUES (1, 'reconcile', 100, 5, 200)"
    ).run();
    db.prepare(
      "INSERT INTO indexer_runs (started_at_ms, kind, files_seen, files_changed, rows_written) VALUES (2, 'incremental', 1, 1, 3)"
    ).run();
    const last = db
      .prepare("SELECT kind, files_changed FROM indexer_runs ORDER BY started_at_ms DESC LIMIT 1")
      .get() as { kind: string; files_changed: number };
    expect(last.kind).toBe("incremental");
    expect(last.files_changed).toBe(1);
  });
});
