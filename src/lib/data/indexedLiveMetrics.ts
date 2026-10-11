import "server-only";
import { promises as fs } from "fs";
import { getDb, prepCached } from "@/lib/db/connection";
import { dbModeRequested } from "@/lib/data";

/** The index's view of a live session — the raw inputs to Agent View's chips. */
/**
 * How far the transcript may run ahead of its indexed copy before the index is
 * treated as not keeping up. Normal reconcile lag is a second or two; anything
 * past this means the indexer is off (`MINDER_INDEXER=0`), paused, or behind a
 * long backfill — and a frozen chip would be wrong, so the caller parses.
 */
export const INDEX_STALE_AFTER_MS = 30_000;

export interface IndexedTurnTokens {
  model: string;
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

export interface IndexedLiveMetrics {
  /** `sessions.cost_usd` — primary (non-sidechain) assistant turns only. */
  costUsd: number;
  /** The most recent primary assistant turn, or null when there is none yet. */
  lastAssistant: IndexedTurnTokens | null;
}

/**
 * Agent View's live cost and context fill, read from the index (#657).
 *
 * The alternative is re-parsing the whole transcript on the main thread every
 * time an actively written session changes — which the ingest worker has just
 * done anyway. Reading the row costs two indexed lookups.
 *
 * The values trail the transcript by the ingest worker's reconcile latency; the
 * worker forwards its post-commit event to the main thread so Agent View
 * re-snapshots once the row is current.
 *
 * Returns null for every failure — DB off (`MINDER_USE_DB=0`), no DB, no row
 * yet, a row more than `INDEX_STALE_AFTER_MS` behind its transcript, an
 * unreadable index or transcript — and the caller falls back to parsing. Same
 * never-fatal contract as `indexedSessionPath`.
 */
export async function indexedLiveMetrics(sessionId: string): Promise<IndexedLiveMetrics | null> {
  if (!dbModeRequested()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const session = prepCached(
      db,
      "SELECT cost_usd, file_path, file_mtime_ms FROM sessions WHERE session_id = ?"
    ).get(sessionId) as { cost_usd: number; file_path: string; file_mtime_ms: number } | undefined;
    if (!session) return null;
    const { mtimeMs } = await fs.stat(session.file_path);
    if (mtimeMs - session.file_mtime_ms > INDEX_STALE_AFTER_MS) return null;
    const last = prepCached(
      db,
      `SELECT model, input_tokens, cache_create_tokens, cache_read_tokens
         FROM turns
        WHERE session_id = ? AND role = 'assistant' AND is_sidechain = 0
        ORDER BY turn_index DESC
        LIMIT 1`
    )
      .get(sessionId) as
      | { model: string | null; input_tokens: number; cache_create_tokens: number; cache_read_tokens: number }
      | undefined;
    return {
      costUsd: session.cost_usd,
      lastAssistant: last
        ? {
            model: last.model ?? "",
            inputTokens: last.input_tokens,
            cacheCreateTokens: last.cache_create_tokens,
            cacheReadTokens: last.cache_read_tokens,
          }
        : null,
    };
  } catch {
    return null;
  }
}
