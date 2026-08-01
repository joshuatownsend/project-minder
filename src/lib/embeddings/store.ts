import "server-only";
import type * as DatabaseT from "better-sqlite3";
import { createHash } from "crypto";
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
/**
 * Columns the current shape requires. A table missing any of them predates a
 * schema change and is dropped rather than migrated: embeddings are a
 * default-off, fully rebuildable derived artifact, so re-running the backfill
 * costs CPU and nothing else, while a hand-written ALTER path would be more
 * code and more risk for the same outcome.
 */
const REQUIRED_COLUMNS = [
  "session_id",
  "turn_index",
  "chunk_index",
  "model",
  "dims",
  "vec",
  "text_hash",
  "created_at",
] as const;

function tableShapeIsCurrent(db: DatabaseT.Database): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${EMBEDDINGS_TABLE})`).all() as {
      name: string;
      pk: number;
    }[];
    if (cols.length === 0) return true; // absent — CREATE will make it right
    const names = new Set(cols.map((c) => c.name));
    if (!REQUIRED_COLUMNS.every((c) => names.has(c))) return false;
    // `model` must be part of the primary key, or INSERT OR REPLACE silently
    // overwrites a chunk's vector when a second model embeds it.
    return cols.some((c) => c.name === "model" && c.pk > 0);
  } catch {
    return true;
  }
}

export function ensureEmbeddingsTable(db: DatabaseT.Database): void {
  if (!tableShapeIsCurrent(db)) {
    db.exec(`DROP TABLE IF EXISTS ${EMBEDDINGS_TABLE}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDINGS_TABLE} (
      session_id  TEXT    NOT NULL,
      turn_index  INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      model       TEXT    NOT NULL,
      dims        INTEGER NOT NULL,
      vec         BLOB    NOT NULL,
      text_hash   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL,
      PRIMARY KEY (session_id, turn_index, chunk_index, model)
    ) WITHOUT ROWID
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ix_chunk_embeddings_model ON ${EMBEDDINGS_TABLE}(model)`
  );
}

/**
 * Chunk text is capped before embedding. `all-MiniLM-L6-v2` truncates at 256
 * word-piece tokens — roughly 1 000 characters of English — so the tail of a
 * 4 000-character chunk is already discarded by the model, and passing it
 * wastes tokenizer time on text that can never reach the encoder. 2 000
 * leaves margin for token-dense input (code, paths, non-English).
 *
 * Lives here rather than in the backfill because the hash below has to agree
 * with it exactly: if the sweep hashed the full text while the backfill
 * hashed the truncated text, every vector would look stale forever.
 */
export const MAX_CHUNK_CHARS = 2_000;

export function truncateForModel(text: string, max = MAX_CHUNK_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Fingerprint of the text a vector was built from.
 *
 * This is what keeps a vector honest across a re-ingest. A session reparse
 * deletes and recreates its `prompts_fts` rows, and `(session_id, turn_index,
 * chunk_index)` is stable across that — so without a content check the
 * backfill treats a recreated chunk as already embedded and leaves the OLD
 * vector permanently attached to NEW text. Semantic search would then return
 * confidently wrong sessions with nothing to notice it by.
 *
 * Hashes the text as the embedder saw it (post-truncation), so a change
 * beyond the model's input window correctly does NOT force a re-embed.
 */
export function hashChunkText(text: string): string {
  return createHash("sha1").update(truncateForModel(text)).digest("hex").slice(0, 16);
}

/**
 * Drop vectors that no longer describe their chunk.
 *
 * Two ways that happens, both silent without this:
 *
 * - **Orphans.** A pruned or deleted session leaves its rows behind, and they
 *   still take part in every semantic scan — consuming result slots and
 *   surfacing sessions that are gone.
 * - **Stale text.** A session reparse deletes and recreates its `prompts_fts`
 *   rows, and `(session_id, turn_index, chunk_index)` survives that intact.
 *   Without a content check the backfill treats a recreated chunk as already
 *   embedded, leaving the OLD vector permanently attached to NEW text —
 *   semantic search returning confidently wrong sessions.
 *
 * The staleness half is compared in JS rather than SQL because SQLite has no
 * hash function; it is bounded by `limit` so a sweep can ride along with a
 * backfill pass without turning into a full-table scan of its own.
 */
export function pruneInvalidVectors(
  db: DatabaseT.Database,
  model: string,
  limit = 5_000
): { orphans: number; stale: number } {
  ensureEmbeddingsTable(db);
  if (!chunkCorpusReady(db)) return { orphans: 0, stale: 0 };

  const orphans = db
    .prepare(
      `DELETE FROM ${EMBEDDINGS_TABLE}
        WHERE NOT EXISTS (
          SELECT 1 FROM prompts_fts f
           WHERE f.session_id  = ${EMBEDDINGS_TABLE}.session_id
             AND f.turn_index  = ${EMBEDDINGS_TABLE}.turn_index
             AND f.chunk_index = ${EMBEDDINGS_TABLE}.chunk_index
        )`
    )
    .run().changes;

  const rows = db
    .prepare(
      `SELECT e.session_id AS sessionId, e.turn_index AS turnIndex,
              e.chunk_index AS chunkIndex, e.text_hash AS storedHash, f.text AS text
         FROM ${EMBEDDINGS_TABLE} e
         JOIN prompts_fts f
           ON f.session_id  = e.session_id
          AND f.turn_index  = e.turn_index
          AND f.chunk_index = e.chunk_index
        WHERE e.model = ?
        LIMIT ?`
    )
    .all(model, limit) as (ChunkKey & { storedHash: string; text: string })[];

  const del = db.prepare(
    `DELETE FROM ${EMBEDDINGS_TABLE}
      WHERE session_id = ? AND turn_index = ? AND chunk_index = ? AND model = ?`
  );
  let stale = 0;
  const txn = db.transaction((candidates: typeof rows) => {
    for (const row of candidates) {
      // An empty stored hash predates hashing; leave it rather than force a
      // full re-embed of an otherwise healthy index.
      if (!row.storedHash) continue;
      if (row.storedHash === hashChunkText(row.text)) continue;
      del.run(row.sessionId, row.turnIndex, row.chunkIndex, model);
      stale++;
    }
  });
  txn(rows);

  return { orphans, stale };
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
 * Checked rather than assumed because a database that has not been opened
 * since v19 landed is a completely ordinary state — it migrates on the next
 * server start, not on merge. Before that, `prompts_fts` holds 500-char
 * previews with no `chunk_index` column and every query here would throw.
 * Embeddings genuinely require the chunk corpus, so the honest response is to
 * report the reason rather than swallow a SQL error as a generic failure.
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
  entries: { key: ChunkKey; vec: Int8Array; hash?: string }[]
): number {
  if (entries.length === 0) return 0;
  ensureEmbeddingsTable(db);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${EMBEDDINGS_TABLE}
       (session_id, turn_index, chunk_index, model, dims, vec, text_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const txn = db.transaction((rows: typeof entries) => {
    for (const { key, vec, hash } of rows) {
      stmt.run(
        key.sessionId,
        key.turnIndex,
        key.chunkIndex,
        model,
        vec.length,
        toBlob(vec),
        hash ?? "",
        now
      );
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
