import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { ensureEmbeddingsTable, putVectors } from "@/lib/embeddings/store";
import { invalidateVectorCache, semanticSearch, semanticSessionKeys } from "@/lib/embeddings/search";
import { runEmbeddingBackfill, truncateForModel } from "@/lib/embeddings/backfill";
import { _resetEmbedderForTesting, _setEmbedderForTesting, type Embedder } from "@/lib/embeddings/model";
import { quantize } from "@/lib/embeddings/quantize";

let Database: typeof import("better-sqlite3") | null = null;
try {
  Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
} catch {
  Database = null;
}
const d = Database ? describe : describe.skip;

type Db = import("better-sqlite3").Database;

const DIMS = 384;

/**
 * Deterministic stand-in for the real model: maps text to a unit vector whose
 * direction is decided by which keyword it contains. Lets the retrieval and
 * ranking logic be tested exactly without loading 80 MB of ONNX weights or
 * depending on a network fetch in CI.
 */
function fakeEmbedder(): Embedder {
  const axes: Record<string, number> = { migration: 0, deploy: 1, styling: 2 };
  return {
    model: "fake-model",
    dims: DIMS,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        const key = Object.keys(axes).find((k) => t.toLowerCase().includes(k));
        v[key ? axes[key] : DIMS - 1] = 1; // already unit-length
        return v;
      });
    },
  };
}

const open: Db[] = [];
afterAll(() => {
  for (const db of open) {
    try { db.close(); } catch { /* already closed */ }
  }
  _resetEmbedderForTesting();
});

function makeDb(): Db {
  const db = new Database!(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE prompts_fts USING fts5(
      session_id UNINDEXED, turn_index UNINDEXED, chunk_index UNINDEXED,
      role UNINDEXED, ts UNINDEXED, text, tokenize='porter unicode61'
    )
  `);
  ensureEmbeddingsTable(db);
  open.push(db);
  return db;
}

function addChunk(db: Db, sessionId: string, text: string, ts = "2026-07-30T00:00:00Z") {
  db.prepare(
    "INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text) VALUES (?,?,?,?,?,?)"
  ).run(sessionId, 0, 0, "assistant", ts, text);
}

function unit(axis: number): Int8Array {
  const v = new Float32Array(DIMS);
  v[axis] = 1;
  return quantize(v);
}

d("semanticSearch", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    invalidateVectorCache();
    _setEmbedderForTesting(fakeEmbedder());
    putVectors(db, "fake-model", [
      { key: { sessionId: "s-migration", turnIndex: 0, chunkIndex: 0 }, vec: unit(0) },
      { key: { sessionId: "s-deploy", turnIndex: 0, chunkIndex: 0 }, vec: unit(1) },
      { key: { sessionId: "s-styling", turnIndex: 0, chunkIndex: 0 }, vec: unit(2) },
    ]);
  });

  it("ranks the semantically nearest session first", async () => {
    const { hits } = await semanticSearch(db, "the migration is failing", 3);
    expect(hits[0].sessionId).toBe("s-migration");
    expect(hits[0].score).toBeGreaterThan(0.99);
  });

  it("scores a session by its BEST chunk, not an average", async () => {
    // A long session with one highly relevant passage is exactly what a
    // semantic query is for; averaging would dilute it toward zero and
    // systematically favour short sessions.
    putVectors(db, "fake-model", [
      { key: { sessionId: "s-mixed", turnIndex: 1, chunkIndex: 0 }, vec: unit(0) },
      { key: { sessionId: "s-mixed", turnIndex: 2, chunkIndex: 0 }, vec: unit(2) },
      { key: { sessionId: "s-mixed", turnIndex: 3, chunkIndex: 0 }, vec: unit(2) },
    ]);
    invalidateVectorCache();
    const { hits } = await semanticSearch(db, "migration", 5);
    const mixed = hits.find((h) => h.sessionId === "s-mixed");
    expect(mixed?.score).toBeGreaterThan(0.99);
  });

  it("returns one entry per session, not per chunk", async () => {
    putVectors(db, "fake-model", [
      { key: { sessionId: "s-migration", turnIndex: 5, chunkIndex: 0 }, vec: unit(0) },
      { key: { sessionId: "s-migration", turnIndex: 6, chunkIndex: 0 }, vec: unit(0) },
    ]);
    invalidateVectorCache();
    const { hits } = await semanticSearch(db, "migration", 10);
    expect(hits.filter((h) => h.sessionId === "s-migration")).toHaveLength(1);
  });

  it("honours the limit and reports what it scanned", async () => {
    const { hits, stats } = await semanticSearch(db, "migration", 2);
    expect(hits).toHaveLength(2);
    expect(stats?.scanned).toBe(3);
  });

  it("degrades to an empty list when no model is available", async () => {
    // An empty list contributes nothing to RRF, so search silently becomes
    // BM25-only rather than erroring — the same posture better-sqlite3 has.
    _setEmbedderForTesting(null, "not installed");
    const { hits, stats } = await semanticSearch(db, "migration", 5);
    expect(hits).toEqual([]);
    expect(stats).toBeNull();
  });

  it("degrades when the model errors mid-query rather than throwing", async () => {
    _setEmbedderForTesting({
      model: "fake-model",
      dims: DIMS,
      embed: vi.fn(async () => { throw new Error("onnx exploded"); }),
    });
    await expect(semanticSearch(db, "migration", 5)).resolves.toMatchObject({ hits: [] });
  });

  it("returns nothing when no vectors exist for the loaded model", async () => {
    // Vectors from a different model must not be scored against this one's
    // query vector — the directions mean different things.
    _setEmbedderForTesting({ ...fakeEmbedder(), model: "other-model" });
    const { hits } = await semanticSearch(db, "migration", 5);
    expect(hits).toEqual([]);
  });

  it("returns nothing for an empty query or a non-positive limit", async () => {
    expect((await semanticSearch(db, "   ", 5)).hits).toEqual([]);
    expect((await semanticSearch(db, "migration", 0)).hits).toEqual([]);
  });

  it("semanticSessionKeys returns just the ranked ids", async () => {
    const keys = await semanticSessionKeys(db, "the migration is failing", 3);
    expect(keys[0]).toBe("s-migration");
    expect(keys).toHaveLength(3);
  });

  it("breaks ties deterministically so pagination is stable", async () => {
    putVectors(db, "fake-model", [
      { key: { sessionId: "aaa", turnIndex: 0, chunkIndex: 0 }, vec: unit(0) },
      { key: { sessionId: "zzz", turnIndex: 0, chunkIndex: 0 }, vec: unit(0) },
    ]);
    invalidateVectorCache();
    const first = await semanticSessionKeys(db, "migration", 5);
    const second = await semanticSessionKeys(db, "migration", 5);
    expect(first).toEqual(second);
  });
});

d("runEmbeddingBackfill", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    invalidateVectorCache();
    _setEmbedderForTesting(fakeEmbedder());
    addChunk(db, "s1", "a migration chunk");
    addChunk(db, "s2", "a deploy chunk");
    addChunk(db, "s3", "a styling chunk");
  });

  it("embeds up to the budget and reports the remainder", async () => {
    const result = await runEmbeddingBackfill(db, 2);
    expect(result.embedded).toBe(2);
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(1);
    expect(result.model).toBe("fake-model");
  });

  it("is resumable — a second pass finishes the rest", async () => {
    await runEmbeddingBackfill(db, 2);
    const second = await runEmbeddingBackfill(db, 10);
    expect(second.embedded).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it("reports nothing-to-do once the corpus is covered", async () => {
    await runEmbeddingBackfill(db, 10);
    const again = await runEmbeddingBackfill(db, 10);
    expect(again.embedded).toBe(0);
    expect(again.stoppedBecause).toBe("nothing-to-do");
  });

  it("stops cleanly with no model rather than throwing", async () => {
    _setEmbedderForTesting(null, "not installed");
    const result = await runEmbeddingBackfill(db, 10);
    expect(result).toMatchObject({ embedded: 0, model: null, stoppedBecause: "no-model" });
  });

  it("keeps committed work when the model fails partway", async () => {
    // Each batch is its own transaction, so a mid-pass failure leaves a
    // partially embedded corpus — which is a working corpus, just smaller.
    // Needs more chunks than EMBED_BATCH_SIZE (32) so the pass actually
    // makes a second call to fail on.
    for (let i = 0; i < 40; i++) addChunk(db, `bulk-${i}`, "a migration chunk");
    let calls = 0;
    _setEmbedderForTesting({
      model: "fake-model",
      dims: DIMS,
      async embed(texts) {
        if (++calls > 1) throw new Error("boom");
        return fakeEmbedder().embed(texts);
      },
    });
    const result = await runEmbeddingBackfill(db, 40);
    expect(result.stoppedBecause).toBe("error");
    // The first batch committed before the second threw.
    expect(result.embedded).toBe(32);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("does not pair vectors with the wrong chunks on a short return", async () => {
    // The worst failure this module could have — nothing downstream could
    // detect a silent off-by-one between chunk keys and vectors.
    _setEmbedderForTesting({
      model: "fake-model",
      dims: DIMS,
      async embed(texts) {
        const all = await fakeEmbedder().embed(texts);
        return all.slice(0, Math.max(0, all.length - 1)); // one short
      },
    });
    const result = await runEmbeddingBackfill(db, 3);
    expect(result.embedded).toBe(2);

    // s3 is newest-first, so the dropped one is the oldest of the batch;
    // whichever survived must carry ITS OWN direction, not a neighbour's.
    _setEmbedderForTesting(fakeEmbedder());
    invalidateVectorCache();
    const { hits } = await semanticSearch(db, "migration", 5);
    for (const hit of hits) {
      if (hit.sessionId === "s2" || hit.sessionId === "s3") expect(hit.score).toBeLessThan(0.5);
    }
  });

  it("caps chunk text before embedding", () => {
    // all-MiniLM-L6-v2 truncates at 256 word-piece tokens (~1 000 chars), so
    // the tail of a 4 000-char chunk can never reach the encoder anyway.
    expect(truncateForModel("x".repeat(5_000)).length).toBe(2_000);
    expect(truncateForModel("short")).toBe("short");
  });
});
