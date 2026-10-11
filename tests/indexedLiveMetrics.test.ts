import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { writeFileSync, utimesSync } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #657: Agent View's live cost and context fill come from the index. Pins what
// the query selects: the session row's cost, and the LATEST PRIMARY assistant
// turn — not a sidechain turn, not a user turn, not an earlier assistant turn.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-indexed-live-", preserveEnv: ["MINDER_USE_DB"] });

const INDEXED_MTIME_MS = Date.UTC(2026, 9, 11);

async function setup() {
  await state.reload();
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const init = await mig.initDb();
  expect(init.error).toBeNull();
  const db = (await conn.getDb())!;
  const { indexedLiveMetrics } = await import("@/lib/data/indexedLiveMetrics");
  return { db, indexedLiveMetrics };
}

type Db = Awaited<ReturnType<typeof setup>>["db"];

/** Index a session whose transcript was last written `aheadMs` after the indexed copy. */
function insertSession(db: Db, sessionId: string, costUsd: number, aheadMs = 0) {
  const file = path.join(state.tmpHome(), `${sessionId}.jsonl`);
  writeFileSync(file, "{}\n");
  const mtime = (INDEXED_MTIME_MS + aheadMs) / 1000;
  utimesSync(file, mtime, mtime);
  db.prepare(
    `INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms, cost_usd)
     VALUES (?, 'C--dev-x', ?, ?, 1, 1, ?)`
  ).run(sessionId, file, INDEXED_MTIME_MS, costUsd);
}

function insertTurn(
  db: Db,
  sessionId: string,
  turnIndex: number,
  role: "user" | "assistant",
  tokens: number,
  isSidechain = 0
) {
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, ts, role, model,
                        input_tokens, cache_create_tokens, cache_read_tokens, is_sidechain)
     VALUES (?, ?, '2026-10-11T00:00:00Z', ?, 'claude-sonnet-4', ?, ?, ?, ?)`
  ).run(sessionId, turnIndex, role, tokens, tokens * 2, tokens * 3, isSidechain);
}

describe.skipIf(!driverAvailable)("indexedLiveMetrics (#657)", () => {
  beforeEach(() => {
    delete process.env.MINDER_USE_DB;
  });
  afterEach(() => {
    delete process.env.MINDER_USE_DB;
  });

  it("returns the session cost and the latest primary assistant turn", async () => {
    const { db, indexedLiveMetrics } = await setup();
    insertSession(db, "s1", 2.5);
    insertTurn(db, "s1", 0, "assistant", 10);
    insertTurn(db, "s1", 1, "assistant", 20); // ← latest primary assistant
    insertTurn(db, "s1", 2, "assistant", 99, 1); // sidechain, later
    insertTurn(db, "s1", 3, "user", 77); // user, latest of all

    expect(await indexedLiveMetrics("s1")).toEqual({
      costUsd: 2.5,
      lastAssistant: {
        model: "claude-sonnet-4",
        inputTokens: 20,
        cacheCreateTokens: 40,
        cacheReadTokens: 60,
      },
    });
  });

  it("reports no assistant turn for an indexed session that has none yet", async () => {
    const { db, indexedLiveMetrics } = await setup();
    insertSession(db, "s2", 0);
    insertTurn(db, "s2", 0, "user", 5);
    expect(await indexedLiveMetrics("s2")).toEqual({ costUsd: 0, lastAssistant: null });
  });

  it("returns null when the session is not indexed, so the caller parses", async () => {
    const { indexedLiveMetrics } = await setup();
    expect(await indexedLiveMetrics("missing")).toBeNull();
  });

  it("tolerates normal reconcile lag", async () => {
    const { db, indexedLiveMetrics } = await setup();
    insertSession(db, "s4", 3, 5_000);
    expect((await indexedLiveMetrics("s4"))?.costUsd).toBe(3);
  });

  it("returns null when the transcript has run well ahead of the index (indexer off or stalled)", async () => {
    const { db, indexedLiveMetrics } = await setup();
    const { INDEX_STALE_AFTER_MS } = await import("@/lib/data/indexedLiveMetrics");
    insertSession(db, "s5", 3, INDEX_STALE_AFTER_MS + 1_000);
    expect(await indexedLiveMetrics("s5")).toBeNull();
  });

  it("returns null with the index switched off, even if a row exists", async () => {
    const { db, indexedLiveMetrics } = await setup();
    insertSession(db, "s3", 1);
    process.env.MINDER_USE_DB = "0";
    expect(await indexedLiveMetrics("s3")).toBeNull();
  });
});
