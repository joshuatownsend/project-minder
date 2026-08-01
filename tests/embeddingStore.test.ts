import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  clearVectors,
  countChunks,
  countEmbedded,
  ensureEmbeddingsTable,
  loadAllVectors,
  putVectors,
  selectUnembedded,
} from "@/lib/embeddings/store";
import { quantize } from "@/lib/embeddings/quantize";

// better-sqlite3 is an optional dependency; skip rather than fail when the
// native driver isn't built, matching how the other DB-backed suites gate.
let Database: typeof import("better-sqlite3") | null = null;
try {
  Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
} catch {
  Database = null;
}

const d = Database ? describe : describe.skip;

type Db = import("better-sqlite3").Database;

const open: Db[] = [];
afterAll(() => {
  for (const db of open) {
    try { db.close(); } catch { /* already closed */ }
  }
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

function addChunk(db: Db, sessionId: string, turn: number, chunk: number, text: string, ts: string) {
  db.prepare(
    "INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text) VALUES (?,?,?,?,?,?)"
  ).run(sessionId, turn, chunk, "assistant", ts, text);
}

function vec(seed: number, dims = 384): Int8Array {
  const f = new Float32Array(dims);
  for (let i = 0; i < dims; i++) f[i] = Math.sin(seed + i) / Math.sqrt(dims / 2);
  return quantize(f);
}

d("embedding store", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    addChunk(db, "s1", 0, 0, "first chunk", "2026-07-01T00:00:00Z");
    addChunk(db, "s1", 0, 1, "second chunk", "2026-07-01T00:00:00Z");
    addChunk(db, "s2", 3, 0, "another session", "2026-07-30T00:00:00Z");
  });

  it("counts the corpus and the embedded subset independently", () => {
    expect(countChunks(db)).toBe(3);
    expect(countEmbedded(db, "m1")).toBe(0);
  });

  it("selects only chunks lacking a vector FOR THAT MODEL", () => {
    // A model switch must not look like a fully embedded corpus. Rows from
    // the old model stay readable and are simply not counted for the new one.
    putVectors(db, "m1", [{ key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) }]);
    expect(selectUnembedded(db, "m1", 10)).toHaveLength(2);
    expect(selectUnembedded(db, "m2", 10)).toHaveLength(3);
  });

  it("returns the newest chunks first", () => {
    // A 40-minute backfill has to make recent sessions searchable early;
    // covering 2024 first would leave the feature useless for most of it.
    const batch = selectUnembedded(db, "m1", 10);
    expect(batch[0].sessionId).toBe("s2");
  });

  it("honours the limit", () => {
    expect(selectUnembedded(db, "m1", 2)).toHaveLength(2);
  });

  it("skips empty chunk text, which would embed to noise", () => {
    addChunk(db, "s3", 0, 0, "", "2026-07-31T00:00:00Z");
    expect(selectUnembedded(db, "m1", 10).some((c) => c.sessionId === "s3")).toBe(false);
  });

  it("round-trips a vector through the blob column", () => {
    const original = vec(7);
    putVectors(db, "m1", [{ key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: original }]);
    const { keys, buffer, dims } = loadAllVectors(db, "m1");
    expect(keys).toEqual([{ sessionId: "s1", turnIndex: 0, chunkIndex: 0 }]);
    expect(buffer.length).toBe(dims);
    expect([...buffer]).toEqual([...original]);
  });

  it("is idempotent on the (session, turn, chunk) key", () => {
    const key = { sessionId: "s1", turnIndex: 0, chunkIndex: 0 };
    putVectors(db, "m1", [{ key, vec: vec(1) }]);
    putVectors(db, "m1", [{ key, vec: vec(2) }]);
    expect(countEmbedded(db, "m1")).toBe(1);
    const { buffer } = loadAllVectors(db, "m1");
    expect([...buffer]).toEqual([...vec(2)]);
  });

  it("keys on the identity triple, not a rowid", () => {
    // prompts_fts is a writer-owned virtual table whose rowids are
    // reassigned on rebuild; keying vectors to one would silently
    // re-associate every vector with different text after a re-index.
    putVectors(db, "m1", [
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) },
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 1 }, vec: vec(2) },
    ]);
    expect(countEmbedded(db, "m1")).toBe(2);
  });

  it("loads only the requested model's vectors", () => {
    putVectors(db, "m1", [{ key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) }]);
    putVectors(db, "m2", [{ key: { sessionId: "s2", turnIndex: 3, chunkIndex: 0 }, vec: vec(3) }]);
    expect(loadAllVectors(db, "m1").keys).toHaveLength(1);
    expect(loadAllVectors(db, "m2").keys).toHaveLength(1);
  });

  it("drops a row whose blob length does not match dims", () => {
    // A truncated write would otherwise contribute a garbage similarity
    // indistinguishable from a real one.
    putVectors(db, "m1", [{ key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) }]);
    db.prepare("UPDATE chunk_embeddings SET vec = ? WHERE session_id = 's1'").run(Buffer.alloc(100));
    const loaded = loadAllVectors(db, "m1");
    expect(loaded.keys).toHaveLength(0);
    expect(loaded.skipped).toBe(1);
    // The buffer is trimmed so `keys.length * dims === buffer.length` holds —
    // the scan derives its bounds from that invariant.
    expect(loaded.buffer.length).toBe(0);
  });

  it("writes nothing for an empty batch", () => {
    expect(putVectors(db, "m1", [])).toBe(0);
  });

  it("clears by model, or entirely", () => {
    putVectors(db, "m1", [{ key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) }]);
    putVectors(db, "m2", [{ key: { sessionId: "s2", turnIndex: 3, chunkIndex: 0 }, vec: vec(2) }]);
    expect(clearVectors(db, "m1")).toBe(1);
    expect(countEmbedded(db, "m1")).toBe(0);
    expect(countEmbedded(db, "m2")).toBe(1);
    expect(clearVectors(db)).toBe(1);
  });

  it("creating the table twice is a no-op", () => {
    ensureEmbeddingsTable(db);
    ensureEmbeddingsTable(db);
    expect(countEmbedded(db, "m1")).toBe(0);
  });
});
