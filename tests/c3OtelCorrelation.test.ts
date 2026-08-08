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

  it("stores requestId on subagent turns too", async () => {
    // The collector captured it and the conversion to a persisted turn dropped
    // it, so every subagent turn stored request_id = NULL and could never join
    // to OTEL — subagents silently excluded from the correlation while the
    // coverage figure reported success on everything else (Codex review of C3).
    const file = path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entries = [
      { type: "user", timestamp: "2026-08-01T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      assistant("m1", REQ_MATCHED, "2026-08-01T12:00:01Z"),
      {
        type: "assistant",
        timestamp: "2026-08-01T12:00:02Z",
        isSidechain: true,
        requestId: "req_011SubagentCCCCCCCCCCC",
        message: {
          id: "m-sub",
          role: "assistant",
          model: "claude-opus-5",
          usage: { input_tokens: 7, output_tokens: 3 },
          content: [{ type: "text", text: "sub" }],
        },
      },
    ];
    await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    const sub = db!
      .prepare("SELECT request_id FROM turns WHERE is_sidechain = 1")
      .get() as { request_id: string | null } | undefined;
    expect(sub?.request_id).toBe("req_011SubagentCCCCCCCCCCC");
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

  it("says there is no telemetry rather than reporting 0% coverage", async () => {
    // Basing hasData on the turn count made a machine with OTEL switched off
    // report `hasData: true, coverage: 0` — "telemetry exists and covers
    // nothing" rather than "there is no telemetry" (Copilot review of #387).
    await setup();
    const { getOtelTurnCoverage } = await import("@/lib/db/otelCorrelation");
    const result = await getOtelTurnCoverage();
    expect(result.turnsWithRequestId).toBe(2);
    expect(result.hasData).toBe(false);
  });

  it("does not count a turn as covered by an out-of-window OTEL event", async () => {
    const db = await setup();
    insertOtel(db, { eventName: "api_request", requestId: REQ_MATCHED, ts: "2020-01-01T00:00:00Z" });
    const { getOtelTurnCoverage } = await import("@/lib/db/otelCorrelation");
    const result = await getOtelTurnCoverage({ since: "2026-01-01T00:00:00Z" });
    // The event exists but predates the window the caller asked about.
    expect(result.matched).toBe(0);
  });

  it("creates a usable turns table from schema.sql alone", async () => {
    // Codex review of #387: `turns.request_id` lived only in migration v24 and
    // the snapshot, so a DB built by executing schema.sql directly — which
    // several tests and utilities do — lacked the column and every session
    // write failed. initDb masks it by running the migration afterwards.
    const fsMod = await import("fs");
    const pathMod = await import("path");
    const schema = fsMod.readFileSync(
      pathMod.resolve(__dirname, "..", "src", "lib", "db", "schema.sql"),
      "utf-8"
    );
    const Database = (await import("better-sqlite3")).default;
    const mem = new Database(":memory:");
    mem.exec(schema);
    const cols = (mem.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    mem.close();
    expect(cols).toContain("request_id");
  });

  it("groups tool events by stated provenance", async () => {
    const db = await setup();
    // `tool_decision`, not `tool_result`: across 200k+ events on the reference
    // index `tool_source` appears on `tool_decision` and nowhere else, and the
    // coverage denominator added below counts that event. The fixture used
    // `tool_result`, which cannot occur — the assertions are unchanged.
    insertOtel(db, { eventName: "tool_decision", toolSource: "builtin" });
    insertOtel(db, { eventName: "tool_decision", toolSource: "builtin" });
    insertOtel(db, { eventName: "tool_decision", toolSource: "mcp" });

    const { getToolProvenance } = await import("@/lib/db/otelCorrelation");
    const result = await getToolProvenance();
    expect(result.hasData).toBe(true);
    expect(result.total).toBe(3);
    expect(result.sources).toEqual([
      { source: "builtin", events: 2, sessions: 1 },
      { source: "mcp", events: 1, sessions: 1 },
    ]);
    // Every call stated a source, so the split speaks for the whole window.
    expect(result.callsInWindow).toBe(3);
    expect(result.sourceCoverage).toBe(1);
  });

  // Codex review of #406: the split is computed only over events carrying
  // `tool_source`, so a window spanning the attribute's introduction described
  // an instrumented subset while presenting as the whole window. Measured on
  // the reference index: 73.2% coverage at 30d, 57.6% at all-time.
  it("reports coverage when only some calls state a source", async () => {
    const db = await setup();
    insertOtel(db, { eventName: "tool_decision", toolSource: "builtin" });
    insertOtel(db, { eventName: "tool_decision", toolSource: "mcp" });
    // Two calls from before Claude Code emitted the attribute.
    insertOtel(db, { eventName: "tool_decision" });
    insertOtel(db, { eventName: "tool_decision" });

    const { getToolProvenance } = await import("@/lib/db/otelCorrelation");
    const result = await getToolProvenance();
    expect(result.total).toBe(2);
    expect(result.callsInWindow).toBe(4);
    expect(result.sourceCoverage).toBe(0.5);
    // The split itself still only describes the sourced half.
    expect(result.sources.reduce((n, s) => n + s.events, 0)).toBe(2);
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

  it("repairs rows an older binary wrote after the DB already reached v24", async () => {
    // The migration's backfill runs once. An older packaged Minder running
    // against an already-v24 database inserts with its four-column statement —
    // still valid — leaving both columns NULL, and returning to a current build
    // repairs nothing because applyPendingMigrations skips v24. The attributes
    // are right there in payload_json, so the telemetry is recoverable but
    // permanently uncorrelated (Codex review, #387).
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();

    // Exactly what an older binary writes: no request_id, no tool_source.
    db!
      .prepare(
        "INSERT INTO otel_events (ts, session_id, event_name, payload_json) VALUES (?, ?, ?, ?)"
      )
      .run(
        "2026-08-01T12:00:00.000Z",
        SESSION,
        "api_request",
        JSON.stringify({ attrs: { request_id: "req_011DowngradeWriteAAAAA", tool_source: "mcp" } })
      );

    const before = db!
      .prepare("SELECT request_id FROM otel_events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(SESSION) as { request_id: string | null };
    expect(before.request_id).toBeNull();

    expect(mig.liftOtelAttributeColumns(db!)).toBeGreaterThan(0);

    const after = db!
      .prepare("SELECT request_id, tool_source FROM otel_events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(SESSION) as { request_id: string | null; tool_source: string | null };
    expect(after.request_id).toBe("req_011DowngradeWriteAAAAA");
    expect(after.tool_source).toBe("mcp");

    // Idempotent, and the watermark means a second call does no work.
    expect(mig.liftOtelAttributeColumns(db!)).toBe(0);
  });
});
