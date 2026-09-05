/**
 * Snapshot consistency for the SQL usage report (#563).
 *
 * #559 made `loadUsageReportFromSql` yield to the event loop between its
 * seventeen synchronous aggregate queries so a long report no longer blocks
 * `/api/health`. Codex flagged that this opened a consistency hole: a reconcile
 * committing during the report would land in some aggregates but not others,
 * and the inconsistent result would be cached. The fix runs the aggregates on
 * an isolated read-only connection inside one `BEGIN DEFERRED` snapshot, so
 * every query sees the same view regardless of concurrent commits.
 *
 * These tests hold that: parity with the synchronous path on a static index,
 * and — the property that matters — a write committed mid-report is invisible
 * to that report but visible to the next one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-usage-snapshot-" });
let tmpHome: string;
beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const userTurn = (ts: string, text: string) => ({
  type: "user",
  timestamp: ts,
  message: { content: [{ type: "text", text }] },
});
const assistantTurn = (ts: string, text: string) => ({
  type: "assistant",
  timestamp: ts,
  message: {
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
});

async function reload() {
  await state.reload();
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    fromDb: await import("@/lib/data/usageFromDb"),
  };
}

async function setup() {
  const reloaded = await reload();
  await reloaded.mig.initDb();
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app", "s1.jsonl"), [
    userTurn("2026-05-01T10:00:00Z", "go"),
    assistantTurn("2026-05-01T10:00:05Z", "one"),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-other", "s2.jsonl"), [
    userTurn("2026-05-02T11:00:00Z", "go"),
    assistantTurn("2026-05-02T11:00:01Z", "two"),
  ]);
  const db = (await reloaded.conn.getDb())!;
  await reloaded.ingest.reconcileAllSessions(db, { projectsDir });
  return { ...reloaded, db };
}

describe.skipIf(!driverAvailable)("loadUsageReportFromSql snapshot consistency (#563)", () => {
  it("the snapshot path agrees with the synchronous path on a static index", async () => {
    const { db, fromDb } = await setup();
    const sync = await fromDb.loadUsageReportFromSql(db, "all");
    const snap = await fromDb.loadUsageReportFromSql(db, "all", undefined, undefined, undefined, {
      readonlySnapshot: true,
    });
    expect(snap.totalSessions).toBe(sync.totalSessions);
    expect(snap.totalCost).toBe(sync.totalCost);
    expect(snap.byProject.map((p) => p.projectSlug).sort()).toEqual(
      sync.byProject.map((p) => p.projectSlug).sort()
    );
  });

  it("does not see a write that commits while the report is running, but the next report does", async () => {
    const { db, fromDb } = await setup();
    expect((await fromDb.loadUsageReportFromSql(db, "all")).totalSessions).toBe(2);

    // Start the snapshot report but don't await it yet. It yields via
    // setImmediate between queries; schedule a delete on the shared connection
    // that lands during one of those yields — after BEGIN DEFERRED has pinned
    // the snapshot at the first query.
    const reportPromise = fromDb.loadUsageReportFromSql(db, "all", undefined, undefined, undefined, {
      readonlySnapshot: true,
    });
    setImmediate(() => {
      db.prepare("DELETE FROM turns WHERE session_id = 's2'").run();
      db.prepare("DELETE FROM sessions WHERE session_id = 's2'").run();
    });
    const duringReport = await reportPromise;

    // The report saw the pre-delete snapshot in EVERY aggregate: totals (the
    // first query) and projectDetails (near the last) must agree that both
    // sessions and both projects exist. Under the pre-fix behaviour (yield on
    // the shared handle) the delete lands between them and the late query
    // reports one project while the early one reports two.
    expect(duringReport.totalSessions).toBe(2);
    expect(duringReport.projectDetails.length).toBe(2);
    expect(duringReport.byProject.length).toBe(2);
    // The delete did commit — a fresh report sees only one session.
    const after = await fromDb.loadUsageReportFromSql(db, "all", undefined, undefined, undefined, {
      readonlySnapshot: true,
    });
    expect(after.totalSessions).toBe(1);
  });
});
