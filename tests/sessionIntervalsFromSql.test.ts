/**
 * SQL source for the portfolio-yield augmentation (#559).
 *
 * `augmentPortfolioYield` re-swept every JSONL transcript after a SQL usage
 * report — 54–111 s per `/api/usage` call on the live tray server, for every
 * period including `today`, blocking the event loop (and `/api/health`, which
 * the tray polls) for the parse. The DB path now feeds it session spans from
 * the `sessions` table instead. These tests hold the shape that path relies
 * on: one visit per session with a recorded span, the head identity the
 * matcher reads, the scope filters, and the millisecond conversion.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import type { SessionHead } from "@/lib/usage/aggregator";
import type { SessionInterval } from "@/lib/usage/yieldAnalysis";

let driverAvailable: boolean;
try {
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-session-intervals-" });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(ts: string, text: string) {
  return { type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(ts: string, text: string) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

async function reload() {
  await state.reload();
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    fromDb: await import("@/lib/data/usageFromDb"),
  };
}

type Visit = { head: SessionHead; intervals: SessionInterval[] };

async function collect(
  source: (visit: (h: SessionHead, i: () => SessionInterval[]) => void) => Promise<void>
): Promise<Visit[]> {
  const out: Visit[] = [];
  await source((head, intervals) => out.push({ head, intervals: intervals() }));
  return out.sort((a, b) => a.head.sessionId.localeCompare(b.head.sessionId));
}

describe.skipIf(!driverAvailable)("sessionIntervalsFromSql (#559)", () => {
  async function setup() {
    const reloaded = await reload();
    await reloaded.mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", "s1.jsonl"), [
      userTurn("2026-05-01T10:00:00Z", "go"),
      assistantTurn("2026-05-01T10:00:05Z", "working"),
      assistantTurn("2026-05-01T10:30:00Z", "done"),
    ]);
    await writeJsonl(path.join(projectsDir, "C--dev-other", "s2.jsonl"), [
      userTurn("2026-05-02T11:00:00Z", "go"),
      assistantTurn("2026-05-02T11:00:01Z", "ok"),
    ]);
    // A user-only transcript: the file path never visits it (no assistant
    // turn → no interval), so the SQL source must not either. On the real
    // index ~3,000 of 8,300 sessions are like this.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "s3-user-only.jsonl"), [
      userTurn("2026-05-03T09:00:00Z", "abandoned before a reply"),
    ]);
    const db = (await reloaded.conn.getDb())!;
    await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
    return { ...reloaded, db };
  }

  it("visits one interval per session, spanning the recorded start and end", async () => {
    const { db, fromDb } = await setup();
    const visits = await collect(fromDb.sessionIntervalsFromSql(db));

    expect(visits.map((v) => v.head.sessionId)).toEqual(["s1", "s2"]);
    const s1 = visits[0];
    expect(s1.head).toMatchObject({ projectSlug: "dev-app", projectDirName: "C--dev-app" });
    expect(s1.head.source).toBe("claude");
    expect(typeof s1.head.homeKey).toBe("string");
    expect(s1.intervals).toHaveLength(1);
    expect(s1.intervals[0]).toMatchObject({
      sessionId: "s1",
      startMs: Date.parse("2026-05-01T10:00:00Z"),
      endMs: Date.parse("2026-05-01T10:30:00Z"),
    });
    expect(typeof s1.intervals[0].costUsd).toBe("number");
  });

  it("skips sessions with no primary assistant turn, matching the file path's session set", async () => {
    const { db, fromDb } = await setup();
    // The row exists — ingest records the transcript — but it has nothing to
    // align a commit against, and the file sweep would never have visited it.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(rows.n).toBe(3);
    const visits = await collect(fromDb.sessionIntervalsFromSql(db));
    expect(visits.map((v) => v.head.sessionId)).toEqual(["s1", "s2"]);
  });

  it("filters by source in SQL", async () => {
    const { db, fromDb } = await setup();
    expect(await collect(fromDb.sessionIntervalsFromSql(db, { source: "claude" }))).toHaveLength(2);
    expect(await collect(fromDb.sessionIntervalsFromSql(db, { source: "codex" }))).toHaveLength(0);
  });

  it("filters by home key in SQL, strictly", async () => {
    const { db, fromDb } = await setup();
    const all = await collect(fromDb.sessionIntervalsFromSql(db));
    const home = all[0].head.homeKey!;
    expect(await collect(fromDb.sessionIntervalsFromSql(db, { home }))).toHaveLength(2);
    expect(await collect(fromDb.sessionIntervalsFromSql(db, { home: "c:/nowhere/.claude" }))).toHaveLength(0);
  });

  it("skips a session with no recorded span rather than emitting a NaN interval", async () => {
    const { db, fromDb } = await setup();
    db.prepare("UPDATE sessions SET start_ts = NULL WHERE session_id = 's2'").run();
    db.prepare("UPDATE sessions SET end_ts = 'not a date' WHERE session_id = 's1'").run();
    expect(await collect(fromDb.sessionIntervalsFromSql(db))).toHaveLength(0);
  });
});
