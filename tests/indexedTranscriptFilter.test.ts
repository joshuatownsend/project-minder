import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installIsolatedState } from "./_helpers/isolatedState";

// #672: the live-status build asks the index which transcripts can have been
// written recently, instead of stat'ing every transcript ever written. Pins
// which files the filter lets it skip — only ones the index knows are old.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const ingest = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/db/ingestSettled", () => ({ readIndexCurrent: async () => ingest.current }));

const state = installIsolatedState({
  prefix: "pm-transcript-filter-",
  preserveEnv: ["MINDER_USE_DB"],
});

const NOW = Date.UTC(2026, 9, 11, 12);
const HOUR = 3_600_000;
const SINCE = NOW - 4 * HOUR;

async function setup() {
  await state.reload();
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  expect((await mig.initDb()).error).toBeNull();
  const db = (await conn.getDb())!;
  const mod = await import("@/lib/data/indexedTranscriptFilter");
  mod._resetIndexedTranscriptsForTesting();
  return { db, ...mod };
}

type Db = Awaited<ReturnType<typeof setup>>["db"];

function index(db: Db, file: string, mtimeMs: number) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_dir_name, file_path, file_mtime_ms, file_size, indexed_at_ms)
     VALUES (?, 'C--dev-x', ?, ?, 1, 1)
     ON CONFLICT(session_id) DO UPDATE SET file_mtime_ms = excluded.file_mtime_ms`
  ).run(file, file, mtimeMs);
}

describe.skipIf(!driverAvailable)("indexedTranscriptFilter (#672)", () => {
  beforeEach(() => {
    delete process.env.MINDER_USE_DB;
    ingest.current = true;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINDER_USE_DB;
  });

  it("skips only transcripts the index knows are old", async () => {
    const { db, indexedTranscriptFilter } = await setup();
    index(db, "recent.jsonl", NOW - HOUR);
    index(db, "old.jsonl", NOW - 30 * HOUR);
    const filter = (await indexedTranscriptFilter(SINCE))!;
    expect(filter.mustStat("recent.jsonl")).toBe(true);
    expect(filter.mustStat("old.jsonl")).toBe(false);
    expect(filter.mustStat("never-indexed.jsonl")).toBe(true);
  });

  it("stats an old transcript again once the index records a new write", async () => {
    const { db, indexedTranscriptFilter } = await setup();
    index(db, "resumed.jsonl", NOW - 30 * HOUR);
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("resumed.jsonl")).toBe(false);
    index(db, "resumed.jsonl", NOW - 1_000);
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("resumed.jsonl")).toBe(true);
  });

  it("picks up a transcript indexed after the known set was loaded", async () => {
    const { db, indexedTranscriptFilter } = await setup();
    index(db, "seed.jsonl", NOW - 30 * HOUR);
    await indexedTranscriptFilter(SINCE); // loads the known set
    index(db, "late.jsonl", NOW - 30 * HOUR);
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("late.jsonl")).toBe(false);
  });

  it("reloads the known set, so a vanished row is stat'ed again", async () => {
    const { db, indexedTranscriptFilter, KNOWN_RELOAD_MS } = await setup();
    index(db, "gone.jsonl", NOW - 30 * HOUR);
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("gone.jsonl")).toBe(false);
    db.prepare("DELETE FROM sessions WHERE file_path = 'gone.jsonl'").run();
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("gone.jsonl")).toBe(false); // still cached
    vi.mocked(Date.now).mockReturnValue(NOW + KNOWN_RELOAD_MS + 1);
    expect((await indexedTranscriptFilter(SINCE))!.mustStat("gone.jsonl")).toBe(true);
  });

  it("gives no filter with the index off", async () => {
    const { indexedTranscriptFilter } = await setup();
    process.env.MINDER_USE_DB = "0";
    expect(await indexedTranscriptFilter(SINCE)).toBeNull();
  });

  it("gives no filter until the index is known to be current", async () => {
    const { indexedTranscriptFilter } = await setup();
    ingest.current = false;
    expect(await indexedTranscriptFilter(SINCE)).toBeNull();
    ingest.current = true;
    expect(await indexedTranscriptFilter(SINCE)).not.toBeNull();
  });
});
