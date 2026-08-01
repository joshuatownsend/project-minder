import "server-only";
import type * as DatabaseT from "better-sqlite3";
import { EMBEDDING_DIMS, fromBlob, toBlob } from "./quantize";

/**
 * Persistence for chunk embeddings.
 *
 * **Keyed by `(session_id, turn_index, chunk_index)`, not by FTS rowid.**
 * `prompts_fts` is a writer-owned virtual table whose rowids are reassigned
 * whenever the writer rebuilds it, and schema.sql documents the triple as the
 * row identity. Keying vectors on a volatile rowid would let a re-index
 * silently re-associate every vector with different text — semantic search
 * confidently returning the wrong sessions, with nothing to notice it by.
 *
 * **`model` is stored per row rather than once in `meta`.** It costs a few MB
 * of redundancy and buys coherence during a model change: rows embedded by
 * the old model stay readable and are simply filtered out of queries, instead
 * of a half-migrated table producing incomparable similarities. Correctness
 * over the megabytes.
 */

export interface ChunkKey {
  sessionId: string;
  turnIndex: number;
  chunkIndex: number;
}

export interface PendingChunk extends ChunkKey {
  text: string;
}

export interface StoredVector extends ChunkKey {
  vec: Int8Array;
}

export const EMBEDDINGS_TABLE = "chunk_embeddings";

/**
 * Create the table if absent.
 *
 * Deliberately NOT a numbered migration in `migrations.ts`. Embeddings are a
 * default-off, fully rebuildable derived artifact: forcing every install to
 * carry the table (and a `DERIVED_VERSION` bump's re-parse) for a feature
 * most users never enable would be a real cost for no benefit. Created on
 * first use instead, and safe to drop at any time.
 */
export function ensureEmbeddingsTable(db: DatabaseT.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDINGS_TABLE} (
      session_id  TEXT    NOT NULL,
      turn_index  INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      model       TEXT    NOT NULL,
      dims        INTEGER NOT NULL,
      vec         BLOB    NOT NULL,
      created_at  TEXT    NOT NULL,
      PRIMARY KEY (session_id, turn_index, chunk_index)
    ) WITHOUT ROWID
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ix_chunk_embeddings_model ON ${EMBEDDINGS_TABLE}(model)`
  );
}

/** How many chunks have a vector for `model`. */
export function countEmbedded(db: DatabaseT.Database, model: string): number {
  ensureEmbeddingsTable(db);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${EMBEDDINGS_TABLE} WHERE model = ?`)
    .get(model) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * True when `prompts_fts` carries `chunk_index`, i.e. the chunked full-body
 * index from schema v19 exists.
 *
 * This is checked rather than assumed because a database that has not been
 * opened since v19 landed is a completely ordinary state — it migrates on the
 * next server start, not on merge. Before that, `prompts_fts` holds 500-char
 * previews with no `chunk_index` column, and every query in this module would
 * throw. Embeddings genuinely require the chunk corpus (a preview is not a
 * meaningful unit to embed), so the honest response is to report the reason,
 * not to silently swallow a SQL error as a generic failure.
 */
export function chunkCorpusReady(db: DatabaseT.Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(prompts_fts)").all() as { name: string }[];
    return cols.some((c) => c.name === "chunk_index");
  } catch {
    return false;
  }
}

/** Total chunks in the FTS corpus — the backfill denominator. */
export function countChunks(db: DatabaseT.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM prompts_fts").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Next batch of chunks with no vector for `model`, newest first.
 *
 * Newest-first matters: a backfill over six figures of chunks takes tens of
 * minutes, and recent sessions are what people search. Ordering this way
 * makes the feature useful long before the pass completes, instead of
 * covering 2024 first.
 */
export function selectUnembedded(
  db: DatabaseT.Database,
  model: string,
  limit: number
): PendingChunk[] {
  ensureEmbeddingsTable(db);
  const rows = db
    .prepare(
      `SELECT f.session_id AS sessionId,
              f.turn_index  AS turnIndex,
              f.chunk_index AS chunkIndex,
              f.text        AS text
         FROM prompts_fts f
         LEFT JOIN ${EMBEDDINGS_TABLE} e
           ON e.session_id  = f.session_id
          AND e.turn_index  = f.turn_index
          AND e.chunk_index = f.chunk_index
          AND e.model       = ?
        WHERE e.session_id IS NULL
          AND f.text IS NOT NULL
          AND length(f.text) > 0
        ORDER BY f.ts DESC
        LIMIT ?`
    )
    .all(model, limit) as PendingChunk[];
  return rows;
}

/** Insert or replace vectors for one model, in a single transaction. */
export function putVectors(
  db: DatabaseT.Database,
  model: string,
  entries: { key: ChunkKey; vec: Int8Array }[]
): number {
  if (entries.length === 0) return 0;
  ensureEmbeddingsTable(db);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${EMBEDDINGS_TABLE}
       (session_id, turn_index, chunk_index, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const txn = db.transaction((rows: typeof entries) => {
    for (const { key, vec } of rows) {
      stmt.run(key.sessionId, key.turnIndex, key.chunkIndex, model, vec.length, toBlob(vec), now);
    }
  });
  txn(entries);
  return entries.length;
}

/**
 * Load every vector for `model`.
 *
 * Returns a flat scan buffer rather than an array of objects: one
 * `Int8Array` of `count * dims` plus a parallel key array. At 157 000 chunks
 * that is ~60 MB of contiguous memory instead of 157 000 small allocations,
 * and the query loop reads it with a single offset walk.
 *
 * Rows whose blob length doesn't match `dims` are skipped rather than
 * producing a garbage similarity — that is the only defence against a
 * truncated write or a stale foreign-model row that slipped the filter.
 */
export function loadAllVectors(
  db: DatabaseT.Database,
  model: string,
  dims: number = EMBEDDING_DIMS
): { keys: ChunkKey[]; buffer: Int8Array; dims: number; skipped: number } {
  ensureEmbeddingsTable(db);
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, turn_index AS turnIndex,
              chunk_index AS chunkIndex, vec
         FROM ${EMBEDDINGS_TABLE}
        WHERE model = ? AND dims = ?`
    )
    .all(model, dims) as (ChunkKey & { vec: Buffer })[];

  const keys: ChunkKey[] = [];
  const buffer = new Int8Array(rows.length * dims);
  let skipped = 0;
  let offset = 0;
  for (const row of rows) {
    const vec = fromBlob(row.vec, dims);
    if (!vec) {
      skipped++;
      continue;
    }
    buffer.set(vec, offset);
    offset += dims;
    keys.push({ sessionId: row.sessionId, turnIndex: row.turnIndex, chunkIndex: row.chunkIndex });
  }
  // Trim when rows were skipped so the buffer length stays exactly
  // keys.length * dims — the scan derives its bounds from that invariant.
  return {
    keys,
    buffer: skipped > 0 ? buffer.subarray(0, keys.length * dims) : buffer,
    dims,
    skipped,
  };
}

/** Drop every vector for a model. Used when switching models. */
export function clearVectors(db: DatabaseT.Database, model?: string): number {
  ensureEmbeddingsTable(db);
  const result = model
    ? db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE model = ?`).run(model)
    : db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE}`).run();
  return result.changes;
}
