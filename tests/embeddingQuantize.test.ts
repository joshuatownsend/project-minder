import { describe, it, expect } from "vitest";
import {
  INT8_SCALE,
  cosineInt8,
  dequantize,
  fromBlob,
  isUnitish,
  quantize,
  toBlob,
} from "@/lib/embeddings/quantize";

/** Deterministic pseudo-random unit vector, so failures are reproducible. */
function unitVector(seed: number, dims = 384): Float32Array {
  const v = new Float32Array(dims);
  let x = seed;
  for (let i = 0; i < dims; i++) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    v[i] = x / 2147483648 - 1;
  }
  let norm = 0;
  for (const c of v) norm += c * c;
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function cosineFloat(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

describe("quantize", () => {
  it("maps the endpoints symmetrically", () => {
    const q = quantize([1, -1, 0]);
    expect([...q]).toEqual([127, -127, 0]);
  });

  it("clamps out-of-range components instead of wrapping", () => {
    // Int8Array assignment wraps silently (128 becomes -128), which would
    // turn a near-+1 component into a near-−1 one — a sign flip in the
    // middle of a similarity score.
    const q = quantize([1.5, -1.5]);
    expect([...q]).toEqual([127, -127]);
  });

  it("round-trips within the quantization step", () => {
    const v = unitVector(7);
    const back = dequantize(quantize(v));
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(1 / (2 * INT8_SCALE) + 1e-6);
    }
  });
});

describe("cosineInt8", () => {
  it("scores an identical vector at ~1", () => {
    const q = quantize(unitVector(3));
    expect(cosineInt8(q, q)).toBeGreaterThan(0.99);
  });

  it("tracks the float cosine closely", () => {
    // This is the property the whole storage decision rests on: if int8
    // cosine drifted from float cosine, 60 MB of vectors would be ranking
    // by something subtly different from similarity.
    for (let seed = 1; seed <= 20; seed++) {
      const a = unitVector(seed);
      const b = unitVector(seed + 100);
      const exact = cosineFloat(a, b);
      const approx = cosineInt8(quantize(a), quantize(b));
      expect(Math.abs(approx - exact)).toBeLessThan(0.01);
    }
  });

  it("preserves rank order across separated similarities, which is all RRF consumes", () => {
    // RRF discards magnitude entirely, so the only thing quantization has to
    // protect is the ordering. Candidates are built by interpolating the
    // query toward a random vector, which produces a SPREAD of similarities
    // — the real-world shape (a probe of the actual model measured 0.76 for
    // related text against ~0 for unrelated).
    const query = unitVector(42);
    const noise = unitVector(999);
    const candidates = Array.from({ length: 20 }, (_, i) => {
      const t = i / 19; // 0 → identical to query, 1 → unrelated
      const v = new Float32Array(query.length);
      for (let d = 0; d < v.length; d++) v[d] = (1 - t) * query[d] + t * noise[d];
      let n = 0;
      for (const c of v) n += c * c;
      n = Math.sqrt(n);
      for (let d = 0; d < v.length; d++) v[d] /= n;
      return v;
    });

    const byFloat = candidates
      .map((c, i) => ({ i, s: cosineFloat(query, c) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i);
    const qq = quantize(query);
    const byInt8 = candidates
      .map((c, i) => ({ i, s: cosineInt8(qq, quantize(c)) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i);

    expect(byInt8).toEqual(byFloat);
  });

  it("may reorder near-ties — the documented cost of int8", () => {
    // Random high-dimensional unit vectors are all near-orthogonal: across
    // 40 of them the top-12 cosines span 0.02–0.11 with adjacent gaps as
    // small as 0.0005, while quantization noise is ~1/254 ≈ 0.004 — eight
    // times larger. Their ordering is therefore noise both before and after
    // quantization. This is pinned as a known limit rather than papered
    // over: it is harmless because RRF damps deep ranks heavily (k=60), and
    // because genuinely relevant hits are separated by far more than 0.004.
    const query = unitVector(42);
    const candidates = Array.from({ length: 40 }, (_, i) => unitVector(i + 1));
    const sims = candidates.map((c) => cosineFloat(query, c)).sort((a, b) => b - a);
    let smallestGap = 1;
    for (let i = 0; i < 11; i++) smallestGap = Math.min(smallestGap, sims[i] - sims[i + 1]);

    expect(smallestGap).toBeLessThan(1 / (2 * INT8_SCALE));
    // The top hit is still the top hit — separation there is large enough.
    const qq = quantize(query);
    const bestFloat = candidates
      .map((c, i) => ({ i, s: cosineFloat(query, c) }))
      .sort((a, b) => b.s - a.s)[0].i;
    const bestInt8 = candidates
      .map((c, i) => ({ i, s: cosineInt8(qq, quantize(c)) }))
      .sort((a, b) => b.s - a.s)[0].i;
    expect(bestInt8).toBe(bestFloat);
  });

  it("returns 0 for mismatched lengths rather than throwing", () => {
    // A foreign-model row is a data condition to filter out, not an
    // exception that should take a search request down.
    expect(cosineInt8(new Int8Array(384), new Int8Array(768))).toBe(0);
    expect(cosineInt8(new Int8Array(0), new Int8Array(0))).toBe(0);
  });
});

describe("isUnitish", () => {
  it("accepts a normalized vector and rejects an unnormalized one", () => {
    expect(isUnitish(unitVector(11))).toBe(true);
    // What a model built without `normalize: true` produces.
    expect(isUnitish([3, 4])).toBe(false);
  });
});

describe("blob round-trip", () => {
  it("survives serialization at the exact byte length", () => {
    const q = quantize(unitVector(5));
    const blob = toBlob(q);
    expect(blob.length).toBe(384);
    const back = fromBlob(blob, 384);
    expect(back).not.toBeNull();
    expect(cosineInt8(back!, q)).toBeGreaterThan(0.999);
  });

  it("rejects a blob whose length does not match dims", () => {
    // The only defence against a truncated write or a stale foreign-model
    // row producing a garbage similarity that looks like a real one.
    expect(fromBlob(Buffer.alloc(200), 384)).toBeNull();
    expect(fromBlob(null, 384)).toBeNull();
    expect(fromBlob(Buffer.alloc(0), 384)).toBeNull();
  });

  it("preserves negative components through the blob", () => {
    const q = quantize([-1, -0.5, 0, 0.5, 1]);
    const back = fromBlob(toBlob(q), 5)!;
    expect([...back]).toEqual([...q]);
  });
});
