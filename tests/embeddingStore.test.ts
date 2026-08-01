import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  clearVectors,
  hashChunkText,
  pruneInvalidVectors,
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

// ─── PR #361 review fixes ────────────────────────────────────────────────────

d("model is part of the primary key", () => {
  let db: Db;
  beforeEach(() => {
    db = makeDb();
    addChunk(db, "s1", 0, 0, "text", "2026-07-01T00:00:00Z");
  });

  it("keeps both models' vectors for the same chunk", () => {
    // The comments claimed old-model rows stay readable during a switch, but
    // with model outside the PK `INSERT OR REPLACE` overwrote them — the
    // documented behaviour was the opposite of the actual one.
    const key = { sessionId: "s1", turnIndex: 0, chunkIndex: 0 };
    putVectors(db, "m1", [{ key, vec: vec(1), hash: "h1" }]);
    putVectors(db, "m2", [{ key, vec: vec(2), hash: "h1" }]);
    expect(countEmbedded(db, "m1")).toBe(1);
    expect(countEmbedded(db, "m2")).toBe(1);
  });

  it("still replaces within one model", () => {
    const key = { sessionId: "s1", turnIndex: 0, chunkIndex: 0 };
    putVectors(db, "m1", [{ key, vec: vec(1), hash: "h1" }]);
    putVectors(db, "m1", [{ key, vec: vec(2), hash: "h2" }]);
    expect(countEmbedded(db, "m1")).toBe(1);
  });
});

d("pruneInvalidVectors", () => {
  let db: Db;
  beforeEach(() => {
    db = makeDb();
    addChunk(db, "s1", 0, 0, "original text", "2026-07-01T00:00:00Z");
    addChunk(db, "s2", 0, 0, "other text", "2026-07-01T00:00:00Z");
  });

  it("drops a vector whose chunk text changed under it", () => {
    // A session reparse recreates prompts_fts rows while the key survives, so
    // without a content check the old vector stays attached to new text and
    // semantic search returns confidently wrong sessions.
    putVectors(db, "m1", [
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1), hash: hashChunkText("original text") },
    ]);
    db.prepare("UPDATE prompts_fts SET text = ? WHERE session_id = 's1'").run("completely different text");

    const result = pruneInvalidVectors(db, "m1");
    expect(result.stale).toBe(1);
    expect(countEmbedded(db, "m1")).toBe(0);
  });

  it("keeps a vector whose text is unchanged", () => {
    putVectors(db, "m1", [
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1), hash: hashChunkText("original text") },
    ]);
    expect(pruneInvalidVectors(db, "m1")).toEqual({ orphans: 0, stale: 0 });
    expect(countEmbedded(db, "m1")).toBe(1);
  });

  it("ignores a change beyond the model's input window", () => {
    // The hash covers the truncated text, so editing past the cap correctly
    // does not force a re-embed of a vector that is still accurate.
    const long = "a".repeat(3_000);
    db.prepare("UPDATE prompts_fts SET text = ? WHERE session_id = 's1'").run(long);
    putVectors(db, "m1", [
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1), hash: hashChunkText(long) },
    ]);
    db.prepare("UPDATE prompts_fts SET text = ? WHERE session_id = 's1'").run(long + "TAIL CHANGED");
    expect(pruneInvalidVectors(db, "m1").stale).toBe(0);
  });

  it("deletes vectors whose session is gone", () => {
    // Orphans still take part in every scan, consuming result slots and
    // surfacing sessions that no longer exist.
    putVectors(db, "m1", [
      { key: { sessionId: "ghost", turnIndex: 0, chunkIndex: 0 }, vec: vec(1), hash: "h" },
    ]);
    expect(pruneInvalidVectors(db, "m1").orphans).toBe(1);
    expect(countEmbedded(db, "m1")).toBe(0);
  });

  it("leaves pre-hash rows alone rather than forcing a full re-embed", () => {
    putVectors(db, "m1", [
      { key: { sessionId: "s1", turnIndex: 0, chunkIndex: 0 }, vec: vec(1) },
    ]);
    expect(pruneInvalidVectors(db, "m1").stale).toBe(0);
    expect(countEmbedded(db, "m1")).toBe(1);
  });

  it("does nothing when the chunk corpus is absent", () => {
    const bare = new Database!(":memory:");
    open.push(bare);
    ensureEmbeddingsTable(bare);
    expect(pruneInvalidVectors(bare, "m1")).toEqual({ orphans: 0, stale: 0 });
  });
});

d("table shape migration", () => {
  it("drops a pre-hash table rather than leaving it unusable", () => {
    // Embeddings are a rebuildable derived artifact, so re-running the
    // backfill costs CPU and nothing else — cheaper and safer than an ALTER
    // path for a default-off feature.
    const db = new Database!(":memory:");
    open.push(db);
    db.exec(`CREATE TABLE chunk_embeddings (
      session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, chunk_index INTEGER NOT NULL,
      model TEXT NOT NULL, dims INTEGER NOT NULL, vec BLOB NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_index, chunk_index)
    ) WITHOUT ROWID`);
    db.prepare(
      "INSERT INTO chunk_embeddings VALUES ('s',0,0,'m1',384,?, '2026-01-01')"
    ).run(Buffer.alloc(384));

    ensureEmbeddingsTable(db);
    const cols = db.prepare("PRAGMA table_info(chunk_embeddings)").all() as { name: string; pk: number }[];
    expect(cols.some((c) => c.name === "text_hash")).toBe(true);
    expect(cols.find((c) => c.name === "model")?.pk).toBeGreaterThan(0);
    expect(countEmbedded(db, "m1")).toBe(0);
  });
});
