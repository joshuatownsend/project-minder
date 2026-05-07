import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import logsFixture from "./fixtures/otlp-logs.json";
import metricsFixture from "./fixtures/otlp-metrics.json";

// OTEL ingest integration test. Uses a temp home so it never touches the
// real ~/.minder/index.db.
//
// Pattern mirrors dbIngest.test.ts — describe.skipIf when the native
// better-sqlite3 binary isn't installed; vi.resetModules() per test to
// keep the globalThis singleton clean.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

interface Reloaded {
  conn: typeof import("@/lib/db/connection");
  mig: typeof import("@/lib/db/migrations");
  otelIngest: typeof import("@/lib/db/otelIngest");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function freshTempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-otel-test-"));
}

async function reloadModules(home: string): Promise<Reloaded> {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const otelIngest = await import("@/lib/db/otelIngest");
  return { conn, mig, otelIngest };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await freshTempHome();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe.skipIf(!driverAvailable)("otelIngest", () => {
  async function setupDb(home: string): Promise<Reloaded> {
    const modules = await reloadModules(home);
    await modules.mig.initDb();
    return modules;
  }

  it("inserts log records into otel_events", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();
    expect(db).not.toBeNull();

    const resource = logsFixture.resourceLogs[0].resource as Parameters<typeof otelIngest.ingestLog>[1];
    const records = logsFixture.resourceLogs[0].scopeLogs[0].logRecords;

    // The fixture has 4 valid records + 1 malformed (null timeUnixNano).
    let rejected = 0;
    for (const record of records) {
      try {
        await otelIngest.ingestLog(record as Parameters<typeof otelIngest.ingestLog>[0], resource);
      } catch {
        rejected++;
      }
    }

    expect(rejected).toBe(1); // the null-timeUnixNano record

    const rows = db!.prepare("SELECT * FROM otel_events ORDER BY ts").all() as Array<{
      ts: string; session_id: string | null; event_name: string; payload_json: string;
    }>;
    expect(rows).toHaveLength(4);
    expect(rows[0].event_name).toBe("tool_result");
    expect(rows[1].event_name).toBe("tool_decision");
    expect(rows[2].event_name).toBe("api_request");
    expect(rows[3].event_name).toBe("tool_result");
  });

  it("extracts session_id from resource attributes", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();

    const resource = logsFixture.resourceLogs[0].resource as Parameters<typeof otelIngest.ingestLog>[1];
    const record = logsFixture.resourceLogs[0].scopeLogs[0].logRecords[0];
    await otelIngest.ingestLog(record as Parameters<typeof otelIngest.ingestLog>[0], resource);

    const row = db!.prepare("SELECT session_id FROM otel_events LIMIT 1").get() as { session_id: string };
    expect(row.session_id).toBe("test-session-abc123");
  });

  it("stores MCP tool attributes in payload_json", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();

    const resource = logsFixture.resourceLogs[0].resource as Parameters<typeof otelIngest.ingestLog>[1];
    // mcp_tool record is index 3
    const mcpRecord = logsFixture.resourceLogs[0].scopeLogs[0].logRecords[3];
    await otelIngest.ingestLog(mcpRecord as Parameters<typeof otelIngest.ingestLog>[0], resource);

    const row = db!.prepare("SELECT payload_json FROM otel_events LIMIT 1").get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { attrs: Record<string, unknown> };
    // tool_parameters should be in attrs so downstream consumers can extract mcp_server_name
    expect(payload.attrs["tool_parameters"]).toContain("context7");
  });

  it("malformed record (null timeUnixNano) throws without corrupting valid records", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();

    const resource = logsFixture.resourceLogs[0].resource as Parameters<typeof otelIngest.ingestLog>[1];
    const malformed = logsFixture.resourceLogs[0].scopeLogs[0].logRecords[4]; // null timeUnixNano
    const valid = logsFixture.resourceLogs[0].scopeLogs[0].logRecords[0];

    await otelIngest.ingestLog(valid as Parameters<typeof otelIngest.ingestLog>[0], resource);
    await expect(
      otelIngest.ingestLog(malformed as Parameters<typeof otelIngest.ingestLog>[0], resource),
    ).rejects.toThrow();

    const count = (db!.prepare("SELECT COUNT(*) as c FROM otel_events").get() as { c: number }).c;
    expect(count).toBe(1); // valid record persisted; malformed record did not corrupt it
  });

  it("inserts metric data points into otel_metrics", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();

    const resource = metricsFixture.resourceMetrics[0].resource as Parameters<typeof otelIngest.ingestMetric>[1];
    const metrics = metricsFixture.resourceMetrics[0].scopeMetrics[0].metrics;
    for (const metric of metrics) {
      await otelIngest.ingestMetric(metric as Parameters<typeof otelIngest.ingestMetric>[0], resource);
    }

    const rows = db!.prepare("SELECT * FROM otel_metrics ORDER BY ts, metric_name").all() as Array<{
      metric_name: string; metric_type: string; value: number; model: string | null; session_id: string | null;
    }>;
    // 2 token.usage data points + 1 cost.usage + 1 session.count = 4 rows
    expect(rows).toHaveLength(4);

    const tokenRows = rows.filter((r) => r.metric_name === "claude_code.token.usage");
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows[0].metric_type).toBe("counter");
    expect(tokenRows[0].model).toBe("claude-opus-4-7");

    const costRow = rows.find((r) => r.metric_name === "claude_code.cost.usage");
    expect(costRow).toBeDefined();
    expect(costRow!.value).toBeCloseTo(0.015);

    const sessionRow = rows.find((r) => r.metric_name === "claude_code.session.count");
    expect(sessionRow).toBeDefined();
    expect(sessionRow!.metric_type).toBe("gauge");
  });

  it("metric with no data points is a no-op", async () => {
    const { conn, otelIngest } = await setupDb(tmpHome);
    const db = await conn.getDb();

    const emptyMetric = { name: "claude_code.empty", sum: { dataPoints: [] } };
    await otelIngest.ingestMetric(emptyMetric as Parameters<typeof otelIngest.ingestMetric>[0], undefined);

    const count = (db!.prepare("SELECT COUNT(*) as c FROM otel_metrics").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("isOtelDbReady returns true after initDb", async () => {
    const { otelIngest } = await setupDb(tmpHome);
    expect(otelIngest.isOtelDbReady()).toBe(true);
  });
});
