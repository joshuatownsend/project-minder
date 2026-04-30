import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import Database from "better-sqlite3";

// Schema smoke test: round-trip every table to validate constraints, FK
// cascades, and FTS5 trigger sync. Runs against an in-memory DB so it
// doesn't touch ~/.minder/index.db.
//
// (Note: db.exec below is the better-sqlite3 multi-statement API, not
// Node's child_process.exec. No shell, no injection surface.)

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db", "schema.sql");

function open() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(sql);
  return db;
}

describe("schema.sql", () => {
  let db: Database.Database;
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

  it("FTS5 trigger keeps prompts_fts in sync with turns", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms) " +
        "VALUES ('fts', 'd', '/fts', 0, 0, 0)"
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, turn_index, ts, role, text_preview) " +
        "VALUES ('fts', 0, '2026-01-01', 'user', 'fix the migration bug')"
    ).run();

    const hits = db.prepare("SELECT session_id, turn_index FROM prompts_fts WHERE prompts_fts MATCH 'migration'").all();
    expect(hits.length).toBe(1);

    db.prepare("UPDATE turns SET text_preview = 'all done' WHERE session_id = 'fts' AND turn_index = 0").run();
    const stillMigration = db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'migration'").all();
    expect(stillMigration.length).toBe(0);
    const nowDone = db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'done'").all();
    expect(nowDone.length).toBe(1);

    db.prepare("DELETE FROM turns WHERE session_id = 'fts'").run();
    const empty = db.prepare("SELECT 1 FROM prompts_fts WHERE prompts_fts MATCH 'done'").all();
    expect(empty.length).toBe(0);
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
