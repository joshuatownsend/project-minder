import "server-only";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";

const THINKING_DISPLAY_CAP = 3000;

interface ThinkingLookupRow {
  file_path: string;
  text_offset: number | null;
}

/**
 * Lazy-fetch thinking block content for a specific turn.
 *
 * Uses `turns.text_offset` (byte position into the JSONL) to read exactly
 * one line without re-parsing the whole file. Returns the concatenated
 * thinking blocks from that JSONL entry, capped at THINKING_DISPLAY_CAP.
 *
 * Returns `null` (rendered as "Thinking content unavailable") when:
 * - `text_offset` is NULL (session predates Phase 2 ingest)
 * - The JSONL file is unreadable or has moved
 * - The line at offset contains no thinking blocks
 *
 * No silent empty-string fallback — callers must handle null explicitly.
 */
export async function readThinkingFromJsonl(
  db: DatabaseT.Database,
  sessionId: string,
  turnIndex: number
): Promise<string | null> {
  const row = prepCached(
    db,
    `SELECT s.file_path, t.text_offset
     FROM turns t
     JOIN sessions s ON s.session_id = t.session_id
     WHERE t.session_id = ? AND t.turn_index = ?`
  ).get(sessionId, turnIndex) as ThinkingLookupRow | undefined;

  if (!row) return null;
  if (row.text_offset == null) return null;

  // Read the JSONL at the known byte offset. A file handle + positioned read
  // avoids loading the entire (potentially 50MB) file into memory.
  let line: string;
  try {
    const buf = Buffer.alloc(65536); // 64KB — larger than any single JSONL line in practice
    const fh = await fs.open(row.file_path, "r");
    try {
      const { bytesRead } = await fh.read(buf, 0, buf.length, row.text_offset);
      const raw = buf.subarray(0, bytesRead).toString("utf8");
      // Trim to the first newline — we want exactly one JSONL entry.
      const nlIdx = raw.indexOf("\n");
      line = nlIdx >= 0 ? raw.slice(0, nlIdx) : raw;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const content: any[] = entry?.message?.content ?? [];
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      parts.push(block.thinking);
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n").slice(0, THINKING_DISPLAY_CAP);
}
