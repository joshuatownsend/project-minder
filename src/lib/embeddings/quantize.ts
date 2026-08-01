/**
 * Int8 quantization for unit-length embedding vectors (pure).
 *
 * **Why quantize at all.** This machine's index holds ~157 000 chunks. At
 * 384 float32 dimensions that is 1 536 bytes per vector — 241 MB of vectors
 * bolted onto an 834 MB database, a 29% increase for a default-off feature.
 * Int8 stores the same vector in 384 bytes: ~60 MB, or a 7% increase.
 *
 * **Why int8 is safe here specifically.** The embedder is asked for
 * L2-normalized output, so every component lies in [-1, 1] and the vector's
 * length is exactly 1. That makes the mapping to int8 a fixed scale (×127)
 * with no per-vector scale factor to store, and it makes cosine similarity a
 * plain dot product. The quantization error per component is bounded by
 * 1/254 ≈ 0.0039; over 384 dimensions the error in the dot product is far
 * smaller than the gaps between genuinely different relevance levels, and
 * only the RANK order is consumed downstream (RRF discards magnitude
 * entirely). `tests/embeddingQuantize.test.ts` pins that rank preservation
 * rather than assuming it.
 */

/** Fixed scale. 127 rather than 128 so +1.0 and -1.0 are symmetric. */
export const INT8_SCALE = 127;

/** The only embedding size this module is used with; asserted, not assumed. */
export const EMBEDDING_DIMS = 384;

/**
 * Quantize a unit-length float vector to int8.
 *
 * Components outside [-1, 1] are clamped rather than rejected: a vector
 * that is very slightly out of range (floating-point drift in the
 * normalization) is still perfectly usable, and refusing it would discard a
 * good embedding over a rounding artifact. A vector that is *grossly* out of
 * range is a caller bug and is caught by `assertUnitish` at the boundary.
 */
export function quantize(vec: Float32Array | number[]): Int8Array {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const scaled = Math.round(vec[i] * INT8_SCALE);
    out[i] = scaled > 127 ? 127 : scaled < -127 ? -127 : scaled;
  }
  return out;
}

/** Reverse of {@link quantize}. Used for tests and diagnostics, not search. */
export function dequantize(vec: Int8Array): Float32Array {
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / INT8_SCALE;
  return out;
}

/**
 * Cosine similarity between two quantized unit vectors, in roughly [-1, 1].
 *
 * Because both inputs were unit-length before quantization, cosine reduces
 * to the dot product — no norms to compute per query, which is what makes a
 * brute-force scan over six figures of vectors affordable.
 *
 * Returns 0 for mismatched lengths rather than throwing: a stored vector
 * from a different model is a data condition to be filtered out, not an
 * exception that should take a search request down.
 */
export function cosineInt8(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (INT8_SCALE * INT8_SCALE);
}

/**
 * True when `vec` is plausibly unit-length. The tolerance is loose on
 * purpose — this is a guard against a caller forgetting `normalize: true`
 * (which yields norms far from 1), not a numerical assertion.
 */
export function isUnitish(vec: Float32Array | number[], tolerance = 0.05): boolean {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.abs(Math.sqrt(sum) - 1) <= tolerance;
}

/** Serialize for a SQLite BLOB column. */
export function toBlob(vec: Int8Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Read a BLOB back. Returns null when the length doesn't match `dims`,
 * which is how a truncated or foreign-model row is dropped instead of
 * silently producing a garbage similarity.
 */
export function fromBlob(blob: Buffer | Uint8Array | null | undefined, dims: number): Int8Array | null {
  if (!blob || blob.length !== dims) return null;
  return new Int8Array(blob.buffer, blob.byteOffset, blob.length);
}
