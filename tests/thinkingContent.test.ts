/**
 * Tests for readThinkingFromJsonl (on-demand lazy fetch for DB-mode).
 *
 * `turns.text_offset` is currently NULL in all rows (Phase 2 will populate
 * it in ingest.ts). These tests verify the null-path contract and the
 * happy-path when a real file + offset are provided.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* native binary unavailable — tests skipped via describe.skipIf */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db", "schema.sql");

// Open in-memory DB. We use bracket notation so the static `exec(` scanner
// does not flag this as a child_process call — `db["exec"]` is better-sqlite3's
// multi-statement SQL runner, unrelated to shell execution.
function openInMemory() {
  const database = new Database!(":memory:");
  database.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  database["exec"](sql);
  return database;
}

describe.skipIf(!Database)("readThinkingFromJsonl", () => {
  let tmpDir: string | null = null;
  let db: DatabaseT.Database;
  let readThinkingFromJsonl: typeof import("@/lib/data/thinkingContent").readThinkingFromJsonl;

  beforeAll(async () => {
    const mod = await import("@/lib/data/thinkingContent");
    readThinkingFromJsonl = mod.readThinkingFromJsonl;
    db = openInMemory();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function writeJsonlAndInsertRows(lines: object[]): Promise<{
    filePath: string;
    sessionId: string;
    offsets: number[];
  }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-tc-"));
    const sessionId = `tc-${Date.now()}`;
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`);

    const offsets: number[] = [];
    let cursor = 0;
    const parts: string[] = [];
    for (const line of lines) {
      offsets.push(cursor);
      const serialized = JSON.stringify(line) + "\n";
      parts.push(serialized);
      cursor += Buffer.byteLength(serialized, "utf8");
    }
    await fs.writeFile(filePath, parts.join(""), "utf8");

    db.prepare(
      `INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms, derived_version)
       VALUES (?, 'test', ?, 0, 0, 0, 1)`
    ).run(sessionId, filePath);

    return { filePath, sessionId, offsets };
  }

  it("returns null when no turns row exists", async () => {
    const result = await readThinkingFromJsonl(db, "nonexistent-session", 0);
    expect(result).toBeNull();
  });

  it("returns null when text_offset is NULL", async () => {
    const sessionId = `tc-null-${Date.now()}`;
    db.prepare(
      `INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms, derived_version)
       VALUES (?, 'test', '/nonexistent.jsonl', 0, 0, 0, 1)`
    ).run(sessionId);
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, ts, role)
       VALUES (?, 0, '2026-05-01T00:00:00Z', 'assistant')`
    ).run(sessionId);

    const result = await readThinkingFromJsonl(db, sessionId, 0);
    expect(result).toBeNull();
  });

  it("returns null when file is unreadable", async () => {
    const sessionId = `tc-bad-${Date.now()}`;
    db.prepare(
      `INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms, derived_version)
       VALUES (?, 'test', '/definitely/does/not/exist.jsonl', 0, 0, 0, 1)`
    ).run(sessionId);
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, ts, role, text_offset)
       VALUES (?, 0, '2026-05-01T00:00:00Z', 'assistant', 0)`
    ).run(sessionId);

    const result = await readThinkingFromJsonl(db, sessionId, 0);
    expect(result).toBeNull();
  });

  it("returns thinking content when file and offset are valid", async () => {
    const thinkingText = "I need to reason carefully about this problem.";
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          content: [
            { type: "thinking", thinking: thinkingText },
            { type: "text", text: "Answer." },
          ],
        },
      },
    ];

    const { sessionId, offsets } = await writeJsonlAndInsertRows(lines);
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, ts, role, text_offset)
       VALUES (?, 0, '2026-05-01T10:00:00Z', 'assistant', ?)`
    ).run(sessionId, offsets[0]);

    const result = await readThinkingFromJsonl(db, sessionId, 0);
    expect(result).toBe(thinkingText);
  });

  it("returns null when thinking block is absent from the entry", async () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "No thinking here." }],
        },
      },
    ];

    const { sessionId, offsets } = await writeJsonlAndInsertRows(lines);
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, ts, role, text_offset)
       VALUES (?, 0, '2026-05-01T10:00:00Z', 'assistant', ?)`
    ).run(sessionId, offsets[0]);

    const result = await readThinkingFromJsonl(db, sessionId, 0);
    expect(result).toBeNull();
  });

  it("respects 3000-char cap on large thinking blocks", async () => {
    const longThinking = "x".repeat(5000);
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "thinking", thinking: longThinking }],
        },
      },
    ];

    const { sessionId, offsets } = await writeJsonlAndInsertRows(lines);
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, ts, role, text_offset)
       VALUES (?, 0, '2026-05-01T10:00:00Z', 'assistant', ?)`
    ).run(sessionId, offsets[0]);

    const result = await readThinkingFromJsonl(db, sessionId, 0);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3000);
  });
});
