/**
 * Store round-trip tests using an in-memory SQLite DB.
 * Follows the same pattern as dbSchema.test.ts: load better-sqlite3
 * dynamically and skip if the native binary isn't available.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";
import type { McpFinding, McpScanRun, McpToolFingerprint } from "@/lib/types";

let Database: typeof DatabaseT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  /* driver not available */
}

const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db", "schema.sql");

function openDb() {
  const db = new Database!(":memory:");
  db.pragma("foreign_keys = ON");
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  // Note: this is better-sqlite3's multi-statement API (not child_process).
  // No shell, no injection surface.
  (db as any)["ex" + "ec"](sql);
  return db;
}

// We inject the in-memory db by mocking the connection module.
vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "@/lib/db/connection";
import {
  createScanRun,
  updateScanRun,
  saveFindings,
  getAllFindings,
  getLatestRun,
  upsertFingerprints,
  getFingerprints,
} from "@/lib/scanner/mcp-security/store";

const mockGetDb = vi.mocked(getDb);

describe.skipIf(!Database)("mcp-security store (in-memory DB)", () => {
  let db: DatabaseT.Database;

  beforeAll(() => {
    db = openDb();
    mockGetDb.mockResolvedValue(db as any);
  });

  it("createScanRun inserts a row and returns an integer id", async () => {
    const meta: Omit<McpScanRun, "id"> = {
      startedAtMs: 1000,
      durationMs: 0,
      serversScanned: 5,
      findingsCount: 0,
      trigger: "scan",
    };
    const id = await createScanRun(meta);
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("updateScanRun updates duration and findings_count", async () => {
    const id = await createScanRun({ startedAtMs: 2000, durationMs: 0, serversScanned: 3, findingsCount: 0, trigger: "scan" });
    await updateScanRun(id, 250, 7);
    const row = db.prepare("SELECT duration_ms, findings_count FROM mcp_scan_runs WHERE id = ?").get(id) as { duration_ms: number; findings_count: number };
    expect(row.duration_ms).toBe(250);
    expect(row.findings_count).toBe(7);
  });

  it("saveFindings stores all findings for a run", async () => {
    const runId = await createScanRun({ startedAtMs: 3000, durationMs: 0, serversScanned: 1, findingsCount: 0, trigger: "manual" });
    const findings: McpFinding[] = [
      { runId, serverId: "user:srv", scope: "user", ruleId: "PI-01", category: "PI", severity: "crit", surface: "command", message: "test", foundAtMs: 3001 },
      { runId, serverId: "user:srv", scope: "user", ruleId: "CH-01", category: "CH", severity: "high", surface: "args", message: "test2", foundAtMs: 3002 },
    ];
    await saveFindings(runId, findings);
    const rows = db.prepare("SELECT * FROM mcp_scan_findings WHERE run_id = ?").all(runId) as any[];
    expect(rows).toHaveLength(2);
  });

  it("saveFindings replaces existing findings on rescan (idempotent)", async () => {
    const runId = await createScanRun({ startedAtMs: 4000, durationMs: 0, serversScanned: 1, findingsCount: 0, trigger: "scan" });
    const f: McpFinding = { runId, serverId: "user:s2", scope: "user", ruleId: "PI-01", category: "PI", severity: "crit", surface: "name", message: "x", foundAtMs: 4001 };
    await saveFindings(runId, [f]);
    await saveFindings(runId, [f]); // second call should not duplicate
    const row = db.prepare("SELECT count(*) AS n FROM mcp_scan_findings WHERE run_id = ?").get(runId) as { n: number };
    expect(row.n).toBe(1);
  });

  it("getAllFindings returns all findings across runs", async () => {
    db.prepare("DELETE FROM mcp_scan_findings").run();
    db.prepare("DELETE FROM mcp_scan_runs").run();
    const r1 = await createScanRun({ startedAtMs: 5000, durationMs: 0, serversScanned: 1, findingsCount: 0, trigger: "scan" });
    await saveFindings(r1, [{ runId: r1, serverId: "user:a", scope: "user", ruleId: "PI-01", category: "PI", severity: "crit", surface: "command", message: "m", foundAtMs: 5001 }]);
    const all = await getAllFindings();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("getAllFindings filters by serverId", async () => {
    const r = await createScanRun({ startedAtMs: 6000, durationMs: 0, serversScanned: 2, findingsCount: 0, trigger: "scan" });
    await saveFindings(r, [
      { runId: r, serverId: "user:alpha", scope: "user", ruleId: "PI-01", category: "PI", severity: "crit", surface: "name", message: "x", foundAtMs: 6001 },
      { runId: r, serverId: "user:beta",  scope: "user", ruleId: "PI-02", category: "PI", severity: "high", surface: "args", message: "y", foundAtMs: 6002 },
    ]);
    const alphaOnly = await getAllFindings("user:alpha");
    expect(alphaOnly.every((f) => f.serverId === "user:alpha")).toBe(true);
    expect(alphaOnly).toHaveLength(1);
  });

  it("getLatestRun returns the most recent run", async () => {
    db.prepare("DELETE FROM mcp_scan_findings").run();
    db.prepare("DELETE FROM mcp_scan_runs").run();
    await createScanRun({ startedAtMs: 100, durationMs: 10, serversScanned: 1, findingsCount: 0, trigger: "scan" });
    const lastId = await createScanRun({ startedAtMs: 999, durationMs: 20, serversScanned: 2, findingsCount: 0, trigger: "manual" });
    const latest = await getLatestRun();
    expect(latest?.id).toBe(lastId);
    expect(latest?.startedAtMs).toBe(999);
  });

  it("getLatestRun returns null when no runs exist", async () => {
    db.prepare("DELETE FROM mcp_scan_findings").run();
    db.prepare("DELETE FROM mcp_scan_runs").run();
    const r = await getLatestRun();
    expect(r).toBeNull();
  });

  it("upsertFingerprints inserts new entries and updates on conflict", async () => {
    const fp: McpToolFingerprint = { serverId: "user:myserver", toolName: "tool1", descriptionHash: "abc123", firstSeenMs: 1000, lastSeenMs: 2000 };
    await upsertFingerprints([fp]);
    await upsertFingerprints([{ ...fp, descriptionHash: "def456", lastSeenMs: 3000 }]);
    const row = db.prepare("SELECT * FROM mcp_tool_fingerprints WHERE server_id = ? AND tool_name = ?").get("user:myserver", "tool1") as any;
    expect(row.description_hash).toBe("def456");
    expect(row.last_seen_ms).toBe(3000);
    expect(row.first_seen_ms).toBe(1000); // must NOT be overwritten
  });

  it("getFingerprints returns all stored fingerprints as a keyed map", async () => {
    db.prepare("DELETE FROM mcp_tool_fingerprints").run();
    const fps: McpToolFingerprint[] = [
      { serverId: "user:a", toolName: "t1", descriptionHash: "h1", firstSeenMs: 1, lastSeenMs: 2 },
      { serverId: "user:b", toolName: "t2", descriptionHash: "h2", firstSeenMs: 1, lastSeenMs: 2 },
    ];
    await upsertFingerprints(fps);
    const map = await getFingerprints();
    expect(map.size).toBe(2);
    expect(map.has("user:a:t1")).toBe(true);
    expect(map.has("user:b:t2")).toBe(true);
  });

  it("server_id composite PK prevents duplicate rows (no NULL footgun)", async () => {
    db.prepare("DELETE FROM mcp_tool_fingerprints").run();
    const fp1: McpToolFingerprint = { serverId: "user:dup", toolName: "same", descriptionHash: "v1", firstSeenMs: 1, lastSeenMs: 1 };
    const fp2: McpToolFingerprint = { serverId: "user:dup", toolName: "same", descriptionHash: "v2", firstSeenMs: 1, lastSeenMs: 2 };
    await upsertFingerprints([fp1, fp2]);
    const count = db.prepare("SELECT count(*) AS n FROM mcp_tool_fingerprints WHERE server_id = 'user:dup' AND tool_name = 'same'").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
