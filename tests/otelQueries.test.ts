import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Integration tests for otelQueries.ts query functions.
// Pattern mirrors otelIngest.test.ts — skipIf when better-sqlite3 native
// binary isn't available; fresh tmpHome + vi.resetModules() per test.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

interface Reloaded {
  conn:     typeof import("@/lib/db/connection");
  mig:      typeof import("@/lib/db/migrations");
  ingest:   typeof import("@/lib/db/otelIngest");
  queries:  typeof import("@/lib/db/otelQueries");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function freshTempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-otelq-test-"));
}

async function reloadModules(home: string): Promise<Reloaded> {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn    = await import("@/lib/db/connection");
  const mig     = await import("@/lib/db/migrations");
  const ingest  = await import("@/lib/db/otelIngest");
  const queries = await import("@/lib/db/otelQueries");
  return { conn, mig, ingest, queries };
}

beforeEach(async () => {
  originalHome        = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome             = await freshTempHome();
  process.env.HOME        = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined)        delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Shared seed helpers ────────────────────────────────────────────────────────

type IngestFn = Reloaded["ingest"]["ingestLogBatch"];
type Resource = Parameters<IngestFn>[1];

function sessionResource(sessionId: string): Resource {
  return {
    attributes: [
      { key: "session.id", value: { stringValue: sessionId } },
    ],
  };
}

function makeAttr(key: string, value: string | number | boolean) {
  if (typeof value === "string")  return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { intValue: String(value) } };
}

function eventRecord(
  nanoTs: number,
  eventName: string,
  attrs: Record<string, string | number | boolean>,
) {
  return {
    timeUnixNano: String(nanoTs),
    body: { stringValue: `claude_code.${eventName}` },
    attributes: [
      makeAttr("event.name", eventName),
      ...Object.entries(attrs).map(([k, v]) => makeAttr(k, v)),
    ],
  };
}

function metricRecord(
  name: string,
  value: number,
  tsNano: number,
  attrs: Record<string, string> = {},
): import("@/lib/db/otelIngest").OtlpMetric {
  return {
    name,
    sum: {
      dataPoints: [
        {
          timeUnixNano: String(tsNano),
          asDouble: value,
          attributes: Object.entries(attrs).map(([k, v]) => makeAttr(k, v)),
        },
      ],
    },
  };
}

// Epoch ms for a date — easy to reason about in test assertions.
const BASE_MS   = 1_746_000_000_000; // 2025-04-30 ish
const BASE_NANO = BASE_MS * 1_000_000;

// ── getEditAcceptance ─────────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getEditAcceptance", () => {
  it("returns empty result when no tool_decision events exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getEditAcceptance({ since: 0 });
    expect(result.hasData).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(result.totalN).toBe(0);
  });

  it("aggregates accept/reject counts per tool", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    const resource = sessionResource("s1");
    await ingest.ingestLogBatch(
      [
        eventRecord(BASE_NANO + 0, "tool_decision", { tool_name: "Edit", decision: "accept", source: "config" }),
        eventRecord(BASE_NANO + 1, "tool_decision", { tool_name: "Edit", decision: "accept", source: "config" }),
        eventRecord(BASE_NANO + 2, "tool_decision", { tool_name: "Edit", decision: "reject", source: "user_reject" }),
        eventRecord(BASE_NANO + 3, "tool_decision", { tool_name: "Write", decision: "accept", source: "config" }),
      ],
      resource,
    );

    const result = await queries.getEditAcceptance({ since: 0 });
    expect(result.hasData).toBe(true);
    expect(result.totalN).toBe(4);

    const edit = result.tools.find((t) => t.name === "Edit");
    expect(edit).toBeDefined();
    expect(edit!.accepted).toBe(2);
    expect(edit!.rejected).toBe(1);
    expect(edit!.n).toBe(3);
    expect(edit!.rate).toBeCloseTo(2 / 3);

    const write = result.tools.find((t) => t.name === "Write");
    expect(write!.accepted).toBe(1);
    expect(write!.rejected).toBe(0);
    expect(write!.rate).toBe(1);
  });

  it("filters by sessionId", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    await ingest.ingestLogBatch(
      [eventRecord(BASE_NANO, "tool_decision", { tool_name: "Edit", decision: "accept", source: "config" })],
      sessionResource("s1"),
    );
    await ingest.ingestLogBatch(
      [eventRecord(BASE_NANO + 1, "tool_decision", { tool_name: "Edit", decision: "reject", source: "user_reject" })],
      sessionResource("s2"),
    );

    const r1 = await queries.getEditAcceptance({ since: 0, sessionId: "s1" });
    expect(r1.totalN).toBe(1);
    expect(r1.tools[0].accepted).toBe(1);

    const r2 = await queries.getEditAcceptance({ since: 0, sessionId: "s2" });
    expect(r2.totalN).toBe(1);
    expect(r2.tools[0].rejected).toBe(1);

  });

  it("filters by since timestamp", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    const oldNano = (BASE_MS - 10_000) * 1_000_000;
    await ingest.ingestLogBatch(
      [
        eventRecord(oldNano, "tool_decision", { tool_name: "Edit", decision: "accept", source: "config" }),
        eventRecord(BASE_NANO, "tool_decision", { tool_name: "Edit", decision: "reject", source: "user_reject" }),
      ],
      sessionResource("s1"),
    );

    const result = await queries.getEditAcceptance({ since: BASE_MS });
    expect(result.totalN).toBe(1);
    expect(result.tools[0].rejected).toBe(1);
  });
});

// ── getToolLatency ────────────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getToolLatency", () => {
  it("returns empty result when no tool_result events exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getToolLatency({ since: 0 });
    expect(result.hasData).toBe(false);
  });

  it("computes p50/p95/max and error rate per tool", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    // Three Read results: 10ms, 20ms, 300ms (p50=20, p95=300, max=300)
    await ingest.ingestLogBatch(
      [
        eventRecord(BASE_NANO + 0, "tool_result", { tool_name: "Read", duration_ms: "10",  success: "true" }),
        eventRecord(BASE_NANO + 1, "tool_result", { tool_name: "Read", duration_ms: "20",  success: "true" }),
        eventRecord(BASE_NANO + 2, "tool_result", { tool_name: "Read", duration_ms: "300", success: "false" }),
        eventRecord(BASE_NANO + 3, "tool_result", { tool_name: "Bash", duration_ms: "500", success: "true" }),
      ],
      sessionResource("s1"),
    );

    const result = await queries.getToolLatency({ since: 0 });
    expect(result.hasData).toBe(true);

    const read = result.tools.find((t) => t.name === "Read");
    expect(read).toBeDefined();
    expect(read!.n).toBe(3);
    expect(read!.max).toBe(300);
    expect(read!.p50).toBe(20);
    expect(read!.errorRate).toBeCloseTo(1 / 3);

    const bash = result.tools.find((t) => t.name === "Bash");
    expect(bash!.n).toBe(1);
    expect(bash!.errorRate).toBe(0);

  });
});

// ── getTokenUsage ─────────────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getTokenUsage", () => {
  it("returns empty result when no token metrics exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getTokenUsage({ period: "7d" });
    expect(result.hasData).toBe(false);
  });

  it("aggregates tokens by day and type", async () => {
    vi.useFakeTimers({ now: BASE_MS + 24 * 60 * 60 * 1000 }); // freeze 1 day after seed data
    try {
      const { mig, ingest, queries } = await reloadModules(tmpHome);
      await mig.initDb();

      const resource = sessionResource("s1");
      for (const [type, value] of [["input", 1000], ["output", 500], ["cacheRead", 200], ["cacheCreation", 50]] as const) {
        await ingest.ingestMetric(
          metricRecord("claude_code.token.usage", value, BASE_NANO, { type }),
          resource,
        );
      }

      const result = await queries.getTokenUsage({ period: "7d" });
      expect(result.hasData).toBe(true);
      expect(result.totals.input).toBe(1000);
      expect(result.totals.output).toBe(500);
      expect(result.totals.cacheRead).toBe(200);
      expect(result.totals.cacheCreation).toBe(50);
      expect(result.totals.total).toBe(1750);
      expect(result.daily).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── getCacheEfficiency ────────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getCacheEfficiency", () => {
  it("returns empty result when no token metrics exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getCacheEfficiency({ period: "7d" });
    expect(result.hasData).toBe(false);
  });

  it("computes hit rate correctly", async () => {
    vi.useFakeTimers({ now: BASE_MS + 24 * 60 * 60 * 1000 });
    try {
      const { mig, ingest, queries } = await reloadModules(tmpHome);
      await mig.initDb();

      const resource = sessionResource("s1");
      for (const [type, value] of [["input", 800], ["output", 200], ["cacheRead", 400], ["cacheCreation", 100]] as const) {
        await ingest.ingestMetric(
          metricRecord("claude_code.token.usage", value, BASE_NANO, { type }),
          resource,
        );
      }

      const result = await queries.getCacheEfficiency({ period: "7d" });
      expect(result.hasData).toBe(true);
      // hitRate = cacheRead / (cacheRead + input + output + cacheCreation)
      //         = 400 / (400 + 800 + 200 + 100)
      //         = 400 / 1500 ≈ 0.267
      // (bounded to [0, 1] — see formula change in src/lib/db/otelQueries.ts)
      expect(result.hitRate).toBeCloseTo(400 / 1500);
      expect(result.totalBillable).toBe(1100);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── getHookActivity ───────────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getHookActivity", () => {
  it("returns empty result when no hook events exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getHookActivity({ since: 0 });
    expect(result.hasData).toBe(false);
  });

  it("aggregates fire counts and computes percentiles per hook_name", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    await ingest.ingestLogBatch(
      [
        eventRecord(BASE_NANO + 0, "hook_execution_complete", { hook_name: "PostToolUse:Bash", total_duration_ms: "100", hook_event: "PostToolUse" }),
        eventRecord(BASE_NANO + 1, "hook_execution_complete", { hook_name: "PostToolUse:Bash", total_duration_ms: "200", hook_event: "PostToolUse" }),
        eventRecord(BASE_NANO + 2, "hook_execution_complete", { hook_name: "PostToolUse:Bash", total_duration_ms: "300", hook_event: "PostToolUse" }),
        eventRecord(BASE_NANO + 3, "hook_execution_complete", { hook_name: "SessionStart:resume", total_duration_ms: "3000", hook_event: "SessionStart" }),
      ],
      sessionResource("s1"),
    );

    const result = await queries.getHookActivity({ since: 0 });
    expect(result.hasData).toBe(true);
    expect(result.totalFires).toBe(4);

    const bash = result.hooks.find((h) => h.name === "PostToolUse:Bash");
    expect(bash!.fires).toBe(3);
    expect(bash!.p50DurationMs).toBe(200);

    const session = result.hooks.find((h) => h.name === "SessionStart:resume");
    expect(session!.fires).toBe(1);
    expect(session!.p50DurationMs).toBe(3000);

  });
});

// ── getPressureSnapshot ───────────────────────────────────────────────────────

describe.skipIf(!driverAvailable)("getPressureSnapshot", () => {
  it("returns zero counts when no pressure events exist", async () => {
    const { mig, queries } = await reloadModules(tmpHome);
    await mig.initDb();
    const result = await queries.getPressureSnapshot({ since: 0 });
    expect(result.apiErrorCount).toBe(0);
    expect(result.compactionCount).toBe(0);
    expect(result.retryExhaustionCount).toBe(0);
    expect(result.hasData).toBe(false);
  });

  it("counts api_error, compaction, and api_retries_exhausted events", async () => {
    const { mig, ingest, queries } = await reloadModules(tmpHome);
    await mig.initDb();

    await ingest.ingestLogBatch(
      [
        eventRecord(BASE_NANO + 0, "api_error", { model: "claude-sonnet-4-6", error: "rate_limit", status_code: "429", attempt: "3" }),
        eventRecord(BASE_NANO + 1, "api_error", { model: "claude-sonnet-4-6", error: "timeout", status_code: "504", attempt: "1" }),
        eventRecord(BASE_NANO + 2, "api_retries_exhausted", { model: "claude-sonnet-4-6", error: "rate_limit", total_attempts: "10" }),
        eventRecord(BASE_NANO + 3, "compaction", { trigger: "auto", success: "true", duration_ms: "2000" }),
      ],
      sessionResource("s1"),
    );

    const result = await queries.getPressureSnapshot({ since: 0 });
    expect(result.apiErrorCount).toBe(2);
    expect(result.retryExhaustionCount).toBe(1);
    expect(result.compactionCount).toBe(1);
    expect(result.lastErrors).toHaveLength(3); // api_error x2 + api_retries_exhausted x1
    expect(result.retryThreshold).toBe(10);
    expect(result.hasData).toBe(true);

  });
});
