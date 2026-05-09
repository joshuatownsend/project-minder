/** DB CRUD layer for MCP security scanner tables. */

import "server-only";
import { getDb } from "../../db/connection";
import type { McpFinding, McpScanRun, McpToolFingerprint } from "../../types";

interface RunRow {
  id: number;
  started_at_ms: number;
  duration_ms: number;
  servers_scanned: number;
  findings_count: number;
  trigger: "scan" | "manual" | "startup";
}

interface FindingRow {
  id: number;
  run_id: number;
  server_id: string;
  scope: "user" | "project";
  project_slug: string | null;
  rule_id: string;
  category: string;
  severity: string;
  surface: string;
  surface_ref: string | null;
  message: string;
  evidence: string | null;
  found_at_ms: number;
}

interface FingerprintRow {
  server_id: string;
  tool_name: string;
  description_hash: string;
  first_seen_ms: number;
  last_seen_ms: number;
}

function rowToFinding(row: FindingRow): McpFinding {
  return {
    id: row.id,
    runId: row.run_id,
    serverId: row.server_id,
    scope: row.scope,
    projectSlug: row.project_slug ?? undefined,
    ruleId: row.rule_id,
    category: row.category as McpFinding["category"],
    severity: row.severity as McpFinding["severity"],
    surface: row.surface as McpFinding["surface"],
    surfaceRef: row.surface_ref ?? undefined,
    message: row.message,
    evidence: row.evidence ?? undefined,
    foundAtMs: row.found_at_ms,
  };
}

function rowToRun(row: RunRow): McpScanRun {
  return {
    id: row.id,
    startedAtMs: row.started_at_ms,
    durationMs: row.duration_ms,
    serversScanned: row.servers_scanned,
    findingsCount: row.findings_count,
    trigger: row.trigger,
  };
}

export async function createScanRun(
  meta: Omit<McpScanRun, "id">,
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = db
    .prepare(
      `INSERT INTO mcp_scan_runs (started_at_ms, duration_ms, servers_scanned, findings_count, trigger)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      meta.startedAtMs,
      meta.durationMs,
      meta.serversScanned,
      meta.findingsCount,
      meta.trigger,
    );
  return result.lastInsertRowid as number;
}

export async function updateScanRun(
  runId: number,
  durationMs: number,
  findingsCount: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  db.prepare(
    "UPDATE mcp_scan_runs SET duration_ms = ?, findings_count = ? WHERE id = ?"
  ).run(durationMs, findingsCount, runId);
}

export async function saveFindings(runId: number, findings: McpFinding[]): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const del = db.prepare("DELETE FROM mcp_scan_findings WHERE run_id = ?");
  const ins = db.prepare(`
    INSERT INTO mcp_scan_findings
      (run_id, server_id, scope, project_slug, rule_id, category, severity,
       surface, surface_ref, message, evidence, found_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    del.run(runId);
    for (const f of findings) {
      ins.run(
        runId,
        f.serverId,
        f.scope,
        f.projectSlug ?? null,
        f.ruleId,
        f.category,
        f.severity,
        f.surface,
        f.surfaceRef ?? null,
        f.message,
        f.evidence ?? null,
        f.foundAtMs,
      );
    }
  });
  txn();
}

/**
 * Upsert tool fingerprints. Each entry is inserted or updated by PK (server_id, tool_name).
 * first_seen_ms is only written on INSERT; last_seen_ms is always refreshed.
 */
export async function upsertFingerprints(fingerprints: McpToolFingerprint[]): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const stmt = db.prepare(`
    INSERT INTO mcp_tool_fingerprints (server_id, tool_name, description_hash, first_seen_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (server_id, tool_name) DO UPDATE SET
      description_hash = excluded.description_hash,
      last_seen_ms     = excluded.last_seen_ms
  `);

  const txn = db.transaction(() => {
    for (const fp of fingerprints) {
      stmt.run(fp.serverId, fp.toolName, fp.descriptionHash, fp.firstSeenMs, fp.lastSeenMs);
    }
  });
  txn();
}

export async function getAllFindings(serverId?: string, runId?: number): Promise<McpFinding[]> {
  const db = await getDb();
  if (!db) return [];

  let sql = "SELECT * FROM mcp_scan_findings WHERE 1=1";
  const args: (string | number)[] = [];
  if (runId !== undefined) { sql += " AND run_id = ?"; args.push(runId); }
  if (serverId !== undefined) { sql += " AND server_id = ?"; args.push(serverId); }
  sql += " ORDER BY found_at_ms DESC";

  return (db.prepare(sql).all(...args) as FindingRow[]).map(rowToFinding);
}

export async function getLatestRun(): Promise<McpScanRun | null> {
  const db = await getDb();
  if (!db) return null;

  const row = db
    .prepare("SELECT * FROM mcp_scan_runs ORDER BY started_at_ms DESC LIMIT 1")
    .get() as RunRow | undefined;

  return row ? rowToRun(row) : null;
}

export async function getFingerprints(): Promise<Map<string, McpToolFingerprint>> {
  const db = await getDb();
  if (!db) return new Map();

  const rows = db
    .prepare("SELECT * FROM mcp_tool_fingerprints")
    .all() as FingerprintRow[];

  const map = new Map<string, McpToolFingerprint>();
  for (const row of rows) {
    map.set(`${row.server_id}:${row.tool_name}`, {
      serverId: row.server_id,
      toolName: row.tool_name,
      descriptionHash: row.description_hash,
      firstSeenMs: row.first_seen_ms,
      lastSeenMs: row.last_seen_ms,
    });
  }
  return map;
}
