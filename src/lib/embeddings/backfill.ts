import "server-only";
import type * as DatabaseT from "better-sqlite3";
import { EMBED_BATCH_SIZE, loadEmbedder } from "./model";
import { quantize } from "./quantize";
import { chunkCorpusReady, countChunks, countEmbedded, putVectors, selectUnembedded } from "./store";
import { invalidateVectorCache } from "./search";

/**
 * Budgeted embedding backfill.
 *
 * Measured on this machine: 15.3 ms per chunk at batch 32, against ~157 000
 * chunks — **roughly 40 minutes** of CPU to embed the corpus once. That number
 * is why this is a budgeted pass rather than a build step: a "reindex now"
 * button that pins a core for forty minutes and blocks the UI is not a
 * feature, and a background loop with no ceiling is worse.
 *
 * Each call embeds at most `maxChunks` and returns. The caller decides how
 * often to come back, so the cost is always bounded by something a human
 * chose.
 */

/** Default per-pass budget: ~30 s of CPU at the measured rate. */
export const DEFAULT_PASS_CHUNKS = 2_000;

/** Chunk text is capped before embedding — see `truncateForModel`. */
export const MAX_CHUNK_CHARS = 2_000;

export interface BackfillResult {
  /** Chunks embedded by this pass. */
  embedded: number;
  /** Chunks still without a vector, after this pass. */
  remaining: number;
  /** Total chunks in the corpus. */
  total: number;
  /** Null when the model is unavailable; the reason is on `embedderFailure()`. */
  model: string | null;
  durationMs: number;
  /** Set when the pass stopped early. */
  stoppedBecause?: "no-model" | "no-chunk-corpus" | "nothing-to-do" | "error";
}

/**
 * all-MiniLM-L6-v2 truncates at 256 word-piece tokens — roughly 1 000
 * characters of English. A 4 000-character chunk is therefore *already*
 * mostly discarded by the model, and passing the whole thing wastes
 * tokenizer time on text that can never reach the encoder.
 *
 * Cutting at 2 000 characters keeps a margin for token-dense text (code,
 * paths, non-English) while dropping the tail the model would ignore anyway.
 * This is a real recall limit and not a tuning knob: the back half of a long
 * chunk is not semantically indexed. It is mitigated by the chunk overlap
 * already in `textChunks.ts` and stated plainly in the help doc rather than
 * left for someone to discover.
 */
export function truncateForModel(text: string, max = MAX_CHUNK_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Embed the next batch of un-embedded chunks.
 *
 * Never throws: a failure mid-pass keeps whatever was already committed
 * (each batch is its own transaction) and reports `stoppedBecause: "error"`.
 * A partially embedded corpus is a working corpus — search just has less to
 * match against.
 */
export async function runEmbeddingBackfill(
  db: DatabaseT.Database,
  maxChunks: number = DEFAULT_PASS_CHUNKS
): Promise<BackfillResult> {
  const started = Date.now();

  // Checked before the model loads: there is no point downloading 80 MB to
  // embed a corpus that doesn't exist yet.
  if (!chunkCorpusReady(db)) {
    return {
      embedded: 0,
      remaining: 0,
      total: 0,
      model: null,
      durationMs: Date.now() - started,
      stoppedBecause: "no-chunk-corpus",
    };
  }

  const total = countChunks(db);

  const embedder = await loadEmbedder();
  if (!embedder) {
    return {
      embedded: 0,
      remaining: total,
      total,
      model: null,
      durationMs: Date.now() - started,
      stoppedBecause: "no-model",
    };
  }

  const model = embedder.model;
  const budget = Math.max(0, Math.min(maxChunks, total));
  let embedded = 0;

  try {
    while (embedded < budget) {
      const batch = selectUnembedded(db, model, Math.min(EMBED_BATCH_SIZE, budget - embedded));
      if (batch.length === 0) {
        return {
          embedded,
          remaining: Math.max(0, total - countEmbedded(db, model)),
          total,
          model,
          durationMs: Date.now() - started,
          stoppedBecause: embedded === 0 ? "nothing-to-do" : undefined,
        };
      }

      const vectors = await embedder.embed(batch.map((c) => truncateForModel(c.text)));
      // A short return would silently pair vectors with the wrong chunks —
      // the worst failure this module could have, because nothing downstream
      // could detect it. Zip by index and stop at the shorter of the two.
      const pairs = [];
      for (let i = 0; i < Math.min(batch.length, vectors.length); i++) {
        pairs.push({
          key: {
            sessionId: batch[i].sessionId,
            turnIndex: batch[i].turnIndex,
            chunkIndex: batch[i].chunkIndex,
          },
          vec: quantize(vectors[i]),
        });
      }
      if (pairs.length === 0) break;

      putVectors(db, model, pairs);
      embedded += pairs.length;
    }
  } catch {
    return {
      embedded,
      remaining: Math.max(0, total - countEmbedded(db, model)),
      total,
      model,
      durationMs: Date.now() - started,
      stoppedBecause: "error",
    };
  } finally {
    // New vectors mean the query-side scan buffer is stale.
    if (embedded > 0) invalidateVectorCache();
  }

  return {
    embedded,
    remaining: Math.max(0, total - countEmbedded(db, model)),
    total,
    model,
    durationMs: Date.now() - started,
  };
}
