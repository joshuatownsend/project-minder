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

  // Read the JSONL at the known byte offset. Read in 64KB chunks until a
  // newline is found so lines larger than one chunk (e.g. very long thinking
  // blocks) are handled correctly without loading the whole file.
  let line: string;
  try {
    const CHUNK = 65536;
    const fh = await fs.open(row.file_path, "r");
    try {
      const chunks: Buffer[] = [];
      let pos = row.text_offset;
      for (;;) {
        const buf = Buffer.alloc(CHUNK);
        const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        const nlIdx = chunk.indexOf(0x0a);
        if (nlIdx >= 0) {
          chunks.push(chunk.subarray(0, nlIdx));
          break;
        }
        chunks.push(chunk);
        pos += bytesRead;
        if (bytesRead < CHUNK) break;
      }
      line = Buffer.concat(chunks).toString("utf8");
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
