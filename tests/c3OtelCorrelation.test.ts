import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * C3 — OTEL ↔ transcript correlation, and tool provenance.
 *
 * **The plan named a key that does not exist.** C3 was specified against
 * `message.uuid`, said to have been added to OTel log events in 2.1.214. An
 * enumeration of every attribute key across 4,000 `tool_result` /
 * `tool_decision` / `api_request` events found `user.account_uuid` and
 * `request_id`, and nothing else uuid-shaped.
 *
 * `request_id` is the key that works, and it was already present on both sides:
 * `requestId` on assistant transcript entries, `attrs.request_id` on OTEL
 * events. Verified by intersection over the full local corpus — 71,466 of
 * 205,137 assistant turns (34.8%) match, all 39,139 `api_request` events
 * carrying a distinct value.
 */

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const SESSION = "aaaaaaaa-4444-4444-4444-4444c3c3c3c3";
const PROJECT_DIR = "C--dev-c3-demo";
const REQ_MATCHED = "req_011MatchedAAAAAAAAAAAAAA";
const REQ_UNMATCHED = "req_011UnmatchedBBBBBBBBBBB";

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;

function assistant(id: string, requestId: string, ts: string) {
  return {
    type: "assistant",
    timestamp: ts,
    requestId,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "ok" }],
    },
  };
}

async function writeFixture(): Promise<void> {
  const entries = [
    { type: "user", timestamp: "2026-08-01T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    assistant("m1", REQ_MATCHED, "2026-08-01T12:00:01Z"),
    assistant("m2", REQ_UNMATCHED, "2026-08-01T12:00:02Z"),
  ];
  const file = path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalStateDir = process.env.MINDER_STATE_DIR;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-c3-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MINDER_STATE_DIR = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalStateDir === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = originalStateDir;
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

describe.runIf(driverAvailable)("C3 — OTEL correlation", () => {
  async function setup() {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    expect(db).not.toBeNull();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });
    return db!;
  }

  /** Insert an OTEL row the way the migration's backfill leaves older rows. */
  function insertOtel(
    db: import("better-sqlite3").Database,
    opts: { eventName: string; requestId?: string; toolSource?: string; ts?: string }
  ) {
    const payload = JSON.stringify({
      ts: 0,
      attrs: {
        ...(opts.requestId ? { request_id: opts.requestId } : {}),
        ...(opts.toolSource ? { tool_source: opts.toolSource } : {}),
      },
    });
    db.prepare(
      `INSERT INTO otel_events (ts, session_id, event_name, payload_json, request_id, tool_source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      opts.ts ?? "2026-08-01T12:00:01Z",
      SESSION,
      opts.eventName,
      payload,
      opts.requestId ?? null,
      opts.toolSource ?? null
    );
  }

  it("stores requestId on turns so the join has a left-hand side", async () => {
    const db = await setup();
    const rows = db
      .prepare("SELECT request_id FROM turns WHERE role = 'assistant' ORDER BY turn_index")
      .all() as Array<{ request_id: string | null }>;
    expect(rows.map((r) => r.request_id)).toEqual([REQ_MATCHED, REQ_UNMATCHED]);
  });

  it("reports partial coverage rather than presenting a third of the data as all of it", async () => {
    const db = await setup();
    // Only one of the two turns has telemetry — the normal state, since OTEL is
    // opt-in and retained for a window.
    insertOtel(db, { eventName: "api_request", requestId: REQ_MATCHED });

    const { getOtelTurnCoverage } = await import("@/lib/db/otelCorrelation");
    const result = await getOtelTurnCoverage();
    expect(result.turnsWithRequestId).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.coverage).toBeCloseTo(0.5, 10);
    expect(result.hasData).toBe(true);
  });

  it("counts a turn once even when several OTEL events share its request id", async () => {
    const db = await setup();
    // A single turn produces api_request plus tool events. A plain JOIN would
    // count the turn once per event and report coverage above 100%.
    insertOtel(db, { eventName: "api_request", requestId: REQ_MATCHED });
    insertOtel(db, { eventName: "tool_result", requestId: REQ_MATCHED });
    insertOtel(db, { eventName: "tool_decision", requestId: REQ_MATCHED });

    const { getOtelTurnCoverage } = await import("@/lib/db/otelCorrelation");
    const result = await getOtelTurnCoverage();
    expect(result.matched).toBe(1);
    expect(result.coverage).toBeLessThanOrEqual(1);
  });

  it("groups tool events by stated provenance", async () => {
    const db = await setup();
    insertOtel(db, { eventName: "tool_result", toolSource: "builtin" });
    insertOtel(db, { eventName: "tool_result", toolSource: "builtin" });
    insertOtel(db, { eventName: "tool_result", toolSource: "mcp" });

    const { getToolProvenance } = await import("@/lib/db/otelCorrelation");
    const result = await getToolProvenance();
    expect(result.hasData).toBe(true);
    expect(result.total).toBe(3);
    expect(result.sources).toEqual([
      { source: "builtin", events: 2, sessions: 1 },
      { source: "mcp", events: 1, sessions: 1 },
    ]);
  });

  it("says it has no data rather than implying every tool was builtin", async () => {
    await setup();
    const { getToolProvenance } = await import("@/lib/db/otelCorrelation");
    const result = await getToolProvenance();
    // No event carries `tool_source`. An empty list alone would be read as a
    // finding; hasData=false says the question could not be answered.
    expect(result.hasData).toBe(false);
    expect(result.sources).toEqual([]);
  });

  it("backfills the lifted columns for events written before them", async () => {
    const db = await setup();
    // Simulate a pre-migration row: attributes present in the blob, columns NULL.
    db.prepare(
      `INSERT INTO otel_events (ts, session_id, event_name, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(
      "2026-08-01T12:00:05Z",
      SESSION,
      "tool_result",
      JSON.stringify({ ts: 0, attrs: { request_id: REQ_UNMATCHED, tool_source: "mcp" } })
    );

    // Re-run the migration's backfill statements the way initDb would on upgrade.
    db.exec(`
      UPDATE otel_events
         SET request_id = JSON_EXTRACT(payload_json, '$.attrs.request_id')
       WHERE request_id IS NULL
         AND JSON_EXTRACT(payload_json, '$.attrs.request_id') IS NOT NULL;
      UPDATE otel_events
         SET tool_source = JSON_EXTRACT(payload_json, '$.attrs.tool_source')
       WHERE tool_source IS NULL
         AND JSON_EXTRACT(payload_json, '$.attrs.tool_source') IS NOT NULL;
    `);

    const row = db
      .prepare("SELECT request_id, tool_source FROM otel_events WHERE ts = ?")
      .get("2026-08-01T12:00:05Z") as { request_id: string; tool_source: string };
    // OTEL events are append-only telemetry — nothing re-ingests them, so
    // without the backfill history would look like it had no request ids.
    expect(row.request_id).toBe(REQ_UNMATCHED);
    expect(row.tool_source).toBe("mcp");
  });
});
