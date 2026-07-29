// Overlapping fixed-size text chunking for the full-body FTS index.
//
// **Why chunk at all.** `prompts_fts` used to mirror `turns.text_preview`
// (500 chars), so anything a turn said past that point was unsearchable —
// the majority of every substantial assistant reply. Indexing the whole
// body as one FTS row would work for matching, but FTS5 scores with bm25,
// which normalizes by document length: a 40 KB turn and a 200-char turn
// indexed as single documents are not comparably rankable, and the long
// one is systematically penalized. Splitting into uniform chunks makes
// document length roughly constant, so bm25 compares like with like.
//
// **Why the chunks overlap.** A fixed stride cuts phrases in half. Split
// "the migration is failing" at a boundary and you get "…the migra" and
// "tion is failing…" — the phrase now exists in NEITHER chunk, so an FTS
// phrase query can never match it, and the failure is silent. Overlapping
// by `overlap` characters guarantees any span shorter than `overlap` is
// wholly contained in at least one chunk. The overlap size is therefore a
// bound on the longest reliably-matchable phrase, not a tuning knob.
//
// The cost is duplication: at the defaults, ~10% of text is indexed twice.
// That is accounted for in the sizing done before this landed.

/**
 * Characters per chunk. 4000 matches ccsearch's choice and sits well
 * inside FTS5's practical per-row comfort zone while still being large
 * enough that most turns are a single chunk (median turn is far smaller).
 */
export const CHUNK_SIZE = 4000;

/**
 * Overlap between consecutive chunks. Any phrase shorter than this is
 * guaranteed to appear intact in at least one chunk. 400 chars comfortably
 * exceeds any realistic search phrase while costing ~10% duplication.
 */
export const CHUNK_OVERLAP = 400;

/**
 * Split `text` into overlapping chunks.
 *
 * - Returns `[]` for null/empty/whitespace-only input, so callers can
 *   iterate the result unconditionally without a null guard and without
 *   writing empty rows into FTS.
 * - Returns a single chunk when the text fits, which is the common case —
 *   no allocation churn for short turns.
 * - The final chunk is whatever remains; it is not padded, and it is not
 *   emitted at all if the previous chunk already covered the end (which
 *   happens when the remainder is shorter than the overlap).
 *
 * @throws RangeError if `overlap >= size` — the stride would be <= 0 and
 * the loop would never terminate. Failing loudly here beats hanging the
 * indexer on a bad constant.
 */
export function chunkText(
  text: string | null | undefined,
  size: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  if (size <= 0) throw new RangeError(`chunk size must be positive (got ${size})`);
  if (overlap < 0) throw new RangeError(`chunk overlap must be non-negative (got ${overlap})`);
  if (overlap >= size) {
    throw new RangeError(`chunk overlap (${overlap}) must be smaller than size (${size})`);
  }

  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= size) return [trimmed];

  const stride = size - overlap;
  const out: string[] = [];
  for (let start = 0; start < trimmed.length; start += stride) {
    out.push(trimmed.slice(start, start + size));
    // Once a chunk reaches the end, stop — otherwise the next iteration
    // would emit a short tail that is entirely contained in this one.
    if (start + size >= trimmed.length) break;
  }
  return out;
}
