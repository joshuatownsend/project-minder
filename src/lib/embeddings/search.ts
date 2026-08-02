import "server-only";
import type * as DatabaseT from "better-sqlite3";
import { loadEmbedder } from "./model";
import { INT8_SCALE, quantize } from "./quantize";
import { chunkCorpusReady, countEmbedded, loadAllVectors, type ChunkKey } from "./store";

/**
 * Semantic retrieval over the chunk corpus.
 *
 * Produces a ranked list of `session_id`s that is handed to the existing
 * Reciprocal Rank Fusion layer as a third retriever alongside prompts-FTS and
 * titles. That is the whole reason #1 built RRF on ordinal position: BM25
 * scores and cosine similarities live on incomparable scales and there is no
 * honest way to normalize one into the other, but their *rank orders* fuse
 * fine. `rrf.ts` already documents "no embedding model" as a retriever that
 * must drop out gracefully — this is that retriever.
 *
 * Every failure path returns an empty list. An empty list contributes nothing
 * to the fusion, so search silently becomes BM25-only rather than erroring:
 * the same optional-dependency posture `better-sqlite3` has.
 */

/**
 * Vectors are cached in memory because the alternative is reading ~157 000
 * BLOBs from SQLite on every keystroke. The cache is built lazily on first
 * semantic query — a user who never enables the flag never pays for it — and
 * is invalidated by row count, which is the cheapest signal that the backfill
 * has advanced.
 */
interface VectorCache {
  model: string;
  count: number;
  keys: ChunkKey[];
  buffer: Int8Array;
  dims: number;
  builtAt: number;
}

const g = globalThis as unknown as { __minderVectorCache?: VectorCache };

/** Rebuild at most this often even if the count changed, so a running
 *  backfill can't rebuild a 60 MB buffer on every query. */
const CACHE_MIN_AGE_MS = 60_000;

export function invalidateVectorCache(): void {
  g.__minderVectorCache = undefined;
}

function getVectors(db: DatabaseT.Database, model: string): VectorCache | null {
  // Pre-v19 databases have no chunk corpus, so any vectors present would be
  // orphaned. Bail before touching the table.
  if (!chunkCorpusReady(db)) return null;
  const count = countEmbedded(db, model);
  if (count === 0) return null;

  const cached = g.__minderVectorCache;
  const fresh =
    cached &&
    cached.model === model &&
    (cached.count === count || Date.now() - cached.builtAt < CACHE_MIN_AGE_MS);
  if (fresh) return cached;

  const { keys, buffer, dims } = loadAllVectors(db, model);
  if (keys.length === 0) return null;
  const built: VectorCache = { model, count, keys, buffer, dims, builtAt: Date.now() };
  g.__minderVectorCache = built;
  return built;
}

export interface SemanticHit {
  sessionId: string;
  /** Best cosine similarity across that session's chunks, in [-1, 1]. */
  score: number;
}

/** Chunks scanned per query — the cost is linear and worth stating. */
export interface SemanticStats {
  scanned: number;
  durationMs: number;
}

/**
 * Rank sessions by best-matching chunk.
 *
 * Brute force, deliberately. **Measured** at full corpus scale on this
 * machine — 157 146 vectors × 384 int8 dimensions, ~60 M multiply-adds — a
 * complete scan takes **162 ms** against a 58 MB resident buffer. That is the
 * same order as the FTS query it runs beside, so an ANN index (sqlite-vec,
 * HNSW) would buy latency that isn't the bottleneck while adding a second
 * native dependency and a structure to keep coherent with a 40-minute
 * backfill. Measured rather than extrapolated on purpose: a previous sizing
 * estimate in this repo was derived by scaling a small sample and came out
 * wrong by 2.6x.
 *
 * Sessions are scored by their BEST chunk, not by an average. A long session
 * with one highly relevant passage is exactly the result a semantic query is
 * for; averaging would dilute it toward zero and systematically favour short
 * sessions.
 */
export async function semanticSearch(
  db: DatabaseT.Database,
  query: string,
  limit: number
): Promise<{ hits: SemanticHit[]; stats: SemanticStats | null }> {
  const q = query.trim();
  if (!q || limit <= 0) return { hits: [], stats: null };

  const embedder = await loadEmbedder();
  if (!embedder) return { hits: [], stats: null };

  const cache = getVectors(db, embedder.model);
  if (!cache) return { hits: [], stats: null };

  let queryVec: Int8Array;
  try {
    const [vec] = await embedder.embed([q]);
    if (!vec || vec.length !== cache.dims) return { hits: [], stats: null };
    queryVec = quantize(vec);
  } catch {
    return { hits: [], stats: null };
  }

  const started = Date.now();
  const { keys, buffer, dims } = cache;
  const bestBySession = new Map<string, number>();

  for (let i = 0; i < keys.length; i++) {
    const offset = i * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += queryVec[d] * buffer[offset + d];
    // Same clamp as `cosineInt8` — quantization rounding can nudge a
    // self-similarity a hair past 1.0, and the hit type documents [-1, 1].
    const raw = dot / (INT8_SCALE * INT8_SCALE);
    const score = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    const sessionId = keys[i].sessionId;
    const prev = bestBySession.get(sessionId);
    if (prev === undefined || score > prev) bestBySession.set(sessionId, score);
  }

  const hits = [...bestBySession.entries()]
    .map(([sessionId, score]) => ({ sessionId, score }))
    // Ties broken by id so pagination and assertions are stable — the same
    // reason `fuseRrf` sorts deterministically.
    .sort((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit);

  return { hits, stats: { scanned: keys.length, durationMs: Date.now() - started } };
}

/** Convenience: just the ranked ids, which is what the fusion consumes. */
export async function semanticSessionKeys(
  db: DatabaseT.Database,
  query: string,
  limit: number
): Promise<string[]> {
  const { hits } = await semanticSearch(db, query, limit);
  return hits.map((h) => h.sessionId);
}
