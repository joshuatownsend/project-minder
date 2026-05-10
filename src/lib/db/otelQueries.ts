import "server-only";
import type DatabaseT from "better-sqlite3";
import { getDb, prepCached } from "./connection";

// OTEL attribute schema — empirically verified 2026-05-07 against real Claude Code traffic.
// Run scripts/probe-otel.mjs to re-verify after Claude Code updates.
//
// otel_events.ts:   TEXT (ISO-8601)  — must convert: CAST(strftime('%s', ts) AS INTEGER) * 1000
// otel_metrics.ts:  INTEGER (ms epoch) — direct comparison, no conversion needed
//
// IMPORTANT: numeric attrs in otel_events are stored as STRINGS ("19", "3178") because the
// OTEL JS SDK emits them as stringValue. Always CAST in SQL when doing arithmetic.
// Numeric attrs in otel_metrics (api_request fields) come as proper JS numbers.
//
// tool_decision (event_name = "tool_decision"):
//   tool_name    = "Edit" | "Write" | "NotebookEdit"
//   tool_use_id  = string
//   decision     = "accept" | "reject"  ← string, NOT boolean
//   source       = "config" | "hook" | "user_permanent" | "user_temporary" | "user_abort" | "user_reject"
//
// tool_result (event_name = "tool_result"):
//   tool_name             = "Read" | "Edit" | "Write" | "Bash" | "mcp_tool" | ...
//   tool_use_id           = string
//   success               = "true" | "false"  ← string, NOT boolean; NOT tool_result.is_error
//   duration_ms           = string (ms) — present on all tool_result events
//   error_type            = string (when failed, e.g. "Error:ENOENT")
//   decision_type         = "accept" | "reject"
//   decision_source       = same values as tool_decision.source
//   tool_parameters       = JSON string (when OTEL_LOG_TOOL_DETAILS=1)
//   tool_input            = JSON string (when OTEL_LOG_TOOL_DETAILS=1)
//
// api_request (event_name = "api_request"):
//   model, cost_usd, duration_ms (number), input_tokens, output_tokens,
//   cache_read_tokens, cache_creation_tokens, request_id, speed, query_source
//
// api_error (event_name = "api_error"):
//   model, error, status_code, duration_ms, attempt, request_id, speed, query_source
//
// api_retries_exhausted (event_name = "api_retries_exhausted"):
//   model, error, status_code, total_attempts, total_retry_duration_ms, speed
//
// hook_execution_complete (event_name = "hook_execution_complete"):
//   hook_event, hook_name, num_hooks (string), num_success (string),
//   num_blocking (string), total_duration_ms (string)
//   ← total_duration_ms is the whole batch; no start/complete pairing needed
//
// compaction (event_name = "compaction"):
//   trigger = "auto" | "manual", success, duration_ms, pre_tokens, post_tokens
//
// Metrics (metric_name):
//   claude_code.token.usage:              type, model, query_source, effort (in attrs_json); value = token count
//   claude_code.cost.usage:               model, query_source, effort (in attrs_json); value = USD
//   claude_code.session.count:            start_type in attrs_json; value = 1 per session
//   claude_code.code_edit_tool.decision:  decision, tool_name, source, language in attrs_json; value = 1 per decision
//   claude_code.active_time.total:        type ("user"|"cli") in attrs_json; value = seconds
//   claude_code.lines_of_code.count:      type ("added"|"removed") in attrs_json; value = line count
//   claude_code.commit.count:             value = 1 per commit

// ── Shared helpers ────────────────────────────────────────────────────────────

export type Period = "today" | "7d" | "30d" | "all";

function periodToMs(period: Period): number {
  const now = Date.now();
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === "7d")  return now - 7 * 24 * 60 * 60 * 1000;
  if (period === "30d") return now - 30 * 24 * 60 * 60 * 1000;
  // "all" — return 0 so the SQL `WHERE timestamp >= ?` matches every row.
  return 0;
}

// otel_events.ts is TEXT (ISO-8601); comparison with toISOString() strings is safe.
function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Edit Acceptance ───────────────────────────────────────────────────────────

export interface ToolAcceptanceRow {
  name: string;
  accepted: number;
  rejected: number;
  rate: number;
  n: number;
}

export interface EditAcceptanceResult {
  tools: ToolAcceptanceRow[];
  totalN: number;
  hasData: boolean;
}

export async function getEditAcceptance(opts: {
  since: number; // ms epoch
  sessionId?: string;
}): Promise<EditAcceptanceResult> {
  const db = await getDb();
  if (!db) return { tools: [], totalN: 0, hasData: false };

  const sinceIso = msToIso(opts.since);
  const conditions = [`event_name = 'tool_decision'`, `ts >= ?`];
  const params: unknown[] = [sinceIso];

  if (opts.sessionId) {
    conditions.push(`session_id = ?`);
    params.push(opts.sessionId);
  }

  const rows = prepCached(
    db,
    `SELECT
       JSON_EXTRACT(payload_json, '$.attrs.tool_name') AS tool_name,
       JSON_EXTRACT(payload_json, '$.attrs.decision')  AS decision,
       COUNT(*)                                        AS n
     FROM otel_events
     WHERE ${conditions.join(" AND ")}
     GROUP BY tool_name, decision
     ORDER BY tool_name`,
  ).all(...params) as { tool_name: string; decision: string; n: number }[];

  const byTool = new Map<string, { accepted: number; rejected: number }>();
  for (const row of rows) {
    if (!row.tool_name) continue;
    const entry = byTool.get(row.tool_name) ?? { accepted: 0, rejected: 0 };
    if (row.decision === "accept") entry.accepted += row.n;
    else entry.rejected += row.n;
    byTool.set(row.tool_name, entry);
  }

  const tools: ToolAcceptanceRow[] = [];
  let totalN = 0;
  for (const [name, { accepted, rejected }] of byTool) {
    const n = accepted + rejected;
    totalN += n;
    tools.push({ name, accepted, rejected, rate: n > 0 ? accepted / n : 0, n });
  }
  tools.sort((a, b) => b.n - a.n);

  return { tools, totalN, hasData: tools.length > 0 };
}

// ── Tool Latency ──────────────────────────────────────────────────────────────

export interface ToolLatencyRow {
  name: string;
  p50: number;
  p95: number;
  max: number;
  n: number;
  errorRate: number;
}

export interface ToolLatencyResult {
  tools: ToolLatencyRow[];
  hasData: boolean;
}

export async function getToolLatency(opts: {
  since: number;
  sessionId?: string;
}): Promise<ToolLatencyResult> {
  const db = await getDb();
  if (!db) return { tools: [], hasData: false };

  const sinceIso = msToIso(opts.since);
  const conditions = [`event_name = 'tool_result'`, `ts >= ?`];
  const params: unknown[] = [sinceIso];

  if (opts.sessionId) {
    conditions.push(`session_id = ?`);
    params.push(opts.sessionId);
  }

  // Fetch raw rows for JS-side percentile computation (SQLite lacks PERCENTILE_CONT).
  // LIMIT 50000 caps memory on high-volume installs; accuracy loss is negligible at that scale.
  const rows = prepCached(
    db,
    `SELECT
       JSON_EXTRACT(payload_json, '$.attrs.tool_name') AS tool_name,
       CAST(JSON_EXTRACT(payload_json, '$.attrs.duration_ms') AS REAL) AS duration_ms,
       JSON_EXTRACT(payload_json, '$.attrs.success') AS success
     FROM otel_events
     WHERE ${conditions.join(" AND ")}
       AND JSON_EXTRACT(payload_json, '$.attrs.duration_ms') IS NOT NULL
     ORDER BY ts DESC
     LIMIT 50000`,
  ).all(...params) as { tool_name: string; duration_ms: number; success: string }[];
  const byTool = new Map<string, { durations: number[]; errors: number }>();
  for (const row of rows) {
    if (!row.tool_name || !Number.isFinite(row.duration_ms)) continue;
    const entry = byTool.get(row.tool_name) ?? { durations: [], errors: 0 };
    entry.durations.push(row.duration_ms);
    if (row.success !== "true") entry.errors++;
    byTool.set(row.tool_name, entry);
  }

  const tools: ToolLatencyRow[] = [];
  for (const [name, { durations, errors }] of byTool) {
    const sorted = durations.slice().sort((a, b) => a - b);
    const n = sorted.length;
    tools.push({
      name,
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      max: Math.round(sorted[n - 1] ?? 0),
      n,
      errorRate: n > 0 ? errors / n : 0,
    });
  }
  tools.sort((a, b) => b.n - a.n);

  return { tools, hasData: tools.length > 0 };
}

// ── Token Usage ───────────────────────────────────────────────────────────────

export interface TokenDay {
  day: string; // YYYY-MM-DD
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TokenUsageResult {
  daily: TokenDay[];
  totals: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number };
  hasData: boolean;
}

// Shared query for token usage metrics — both getTokenUsage and getCacheEfficiency use
// the same aggregation; fetching once per call is fine (fast SQLite local aggregation).
type RawTokenRow = { day: string; type: string; total: number };

function queryRawTokenDays(db: DatabaseT.Database, sinceMs: number): RawTokenRow[] {
  return prepCached(
    db,
    `SELECT
       date(ts / 1000, 'unixepoch') AS day,
       JSON_EXTRACT(attrs_json, '$.type') AS type,
       SUM(value) AS total
     FROM otel_metrics
     WHERE metric_name = 'claude_code.token.usage'
       AND ts >= ?
     GROUP BY day, type
     ORDER BY day`,
  ).all(sinceMs) as RawTokenRow[];
}

function pivotTokenRows(rows: RawTokenRow[]): TokenDay[] {
  const dayMap = new Map<string, TokenDay>();
  for (const row of rows) {
    const d = dayMap.get(row.day) ?? { day: row.day, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    if (row.type === "input")              d.input += row.total;
    else if (row.type === "output")        d.output += row.total;
    else if (row.type === "cacheRead")     d.cacheRead += row.total;
    else if (row.type === "cacheCreation") d.cacheCreation += row.total;
    dayMap.set(row.day, d);
  }
  return [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function getTokenUsage(opts: { period: Period }): Promise<TokenUsageResult> {
  const db = await getDb();
  const empty = { daily: [], totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }, hasData: false };
  if (!db) return empty;

  const rows = queryRawTokenDays(db, periodToMs(opts.period));
  if (rows.length === 0) return empty;

  const daily = pivotTokenRows(rows);
  const totals = daily.reduce(
    (acc, d) => ({
      input:         acc.input + d.input,
      output:        acc.output + d.output,
      cacheRead:     acc.cacheRead + d.cacheRead,
      cacheCreation: acc.cacheCreation + d.cacheCreation,
      total:         acc.total + d.input + d.output + d.cacheRead + d.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  );

  return { daily, totals, hasData: true };
}

// ── Cache Efficiency ──────────────────────────────────────────────────────────

export interface CacheDay {
  day: string;
  hitRate: number; // 0–1
}

export interface CacheEfficiencyResult {
  hitRate: number;
  daily: CacheDay[];
  totalBillable: number; // input + output + cacheCreation tokens
  hasData: boolean;
}

export async function getCacheEfficiency(opts: { period: Period }): Promise<CacheEfficiencyResult> {
  const db = await getDb();
  const empty = { hitRate: 0, daily: [], totalBillable: 0, hasData: false };
  if (!db) return empty;

  const rows = queryRawTokenDays(db, periodToMs(opts.period));
  if (rows.length === 0) return empty;

  const daily: CacheDay[] = [];
  let sumCacheRead = 0, sumBillable = 0, sumTotalFlow = 0;

  for (const d of pivotTokenRows(rows)) {
    // Hit rate is "what fraction of total token flow came from cache?"
    // — bounded to [0, 1]. The denominator includes cacheRead so the ratio
    // can't exceed 1 (an earlier formula divided cacheRead by billable
    // tokens only and produced ratios of 1500%+ for sessions that re-read
    // a large cached system prompt across many turns).
    const billable = d.input + d.output + d.cacheCreation;
    const totalFlow = billable + d.cacheRead;
    const rate = totalFlow > 0 ? d.cacheRead / totalFlow : 0;
    daily.push({ day: d.day, hitRate: rate });
    sumCacheRead += d.cacheRead;
    sumBillable += billable;
    sumTotalFlow += totalFlow;
  }

  return {
    hitRate: sumTotalFlow > 0 ? sumCacheRead / sumTotalFlow : 0,
    daily,
    totalBillable: sumBillable,
    hasData: true,
  };
}

// ── Hook Activity ─────────────────────────────────────────────────────────────

export interface HookRow {
  name: string;
  fires: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export interface HookActivityResult {
  hooks: HookRow[];
  totalFires: number;
  hasData: boolean;
}

export async function getHookActivity(opts: {
  since: number;
}): Promise<HookActivityResult> {
  const db = await getDb();
  if (!db) return { hooks: [], totalFires: 0, hasData: false };

  const sinceIso = msToIso(opts.since);

  const rows = prepCached(
    db,
    `SELECT
       JSON_EXTRACT(payload_json, '$.attrs.hook_name') AS hook_name,
       CAST(JSON_EXTRACT(payload_json, '$.attrs.total_duration_ms') AS REAL) AS duration_ms
     FROM otel_events
     WHERE event_name = 'hook_execution_complete'
       AND ts >= ?
       AND JSON_EXTRACT(payload_json, '$.attrs.hook_name') IS NOT NULL
     ORDER BY ts DESC
     LIMIT 10000`,
  ).all(sinceIso) as { hook_name: string; duration_ms: number }[];

  const byHook = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.hook_name || !Number.isFinite(row.duration_ms)) continue;
    const arr = byHook.get(row.hook_name) ?? [];
    arr.push(row.duration_ms);
    byHook.set(row.hook_name, arr);
  }

  const hooks: HookRow[] = [];
  let totalFires = 0;
  for (const [name, durations] of byHook) {
    const sorted = durations.slice().sort((a, b) => a - b);
    hooks.push({
      name,
      fires: sorted.length,
      p50DurationMs: Math.round(percentile(sorted, 50)),
      p95DurationMs: Math.round(percentile(sorted, 95)),
    });
    totalFires += sorted.length;
  }
  hooks.sort((a, b) => b.fires - a.fires);

  return { hooks, totalFires, hasData: hooks.length > 0 };
}

// ── Pressure Snapshot ─────────────────────────────────────────────────────────

export interface PressureError {
  ts: string; // ISO-8601
  event: string;
  model: string | null;
  error: string | null;
  attempt: number | null;
  statusCode: number | null;
}

export interface PressureResult {
  apiErrorCount: number;
  compactionCount: number;
  retryExhaustionCount: number;
  retryThreshold: number;
  lastErrors: PressureError[];
  hasData: boolean;
}

export async function getPressureSnapshot(opts: {
  since: number;
}): Promise<PressureResult> {
  const db = await getDb();
  const empty: PressureResult = {
    apiErrorCount: 0,
    compactionCount: 0,
    retryExhaustionCount: 0,
    retryThreshold: 10,
    lastErrors: [],
    hasData: false,
  };
  if (!db) return empty;

  const sinceIso = msToIso(opts.since);

  const counts = prepCached(
    db,
    `SELECT event_name, COUNT(*) AS n
     FROM otel_events
     WHERE event_name IN ('api_error', 'compaction', 'api_retries_exhausted')
       AND ts >= ?
     GROUP BY event_name`,
  ).all(sinceIso) as { event_name: string; n: number }[];

  let apiErrorCount = 0, compactionCount = 0, retryExhaustionCount = 0;
  for (const row of counts) {
    if (row.event_name === "api_error")             apiErrorCount = row.n;
    else if (row.event_name === "compaction")        compactionCount = row.n;
    else if (row.event_name === "api_retries_exhausted") retryExhaustionCount = row.n;
  }

  const errorRows = prepCached(
    db,
    `SELECT
       ts,
       event_name,
       JSON_EXTRACT(payload_json, '$.attrs.model')       AS model,
       JSON_EXTRACT(payload_json, '$.attrs.error')       AS error,
       JSON_EXTRACT(payload_json, '$.attrs.attempt')     AS attempt,
       JSON_EXTRACT(payload_json, '$.attrs.status_code') AS status_code
     FROM otel_events
     WHERE event_name IN ('api_error', 'api_retries_exhausted')
       AND ts >= ?
     ORDER BY ts DESC
     LIMIT 10`,
  ).all(sinceIso) as {
    ts: string;
    event_name: string;
    model: string | null;
    error: string | null;
    attempt: string | number | null;
    status_code: string | number | null;
  }[];

  const lastErrors: PressureError[] = errorRows.map((r) => ({
    ts: r.ts,
    event: r.event_name,
    model: r.model,
    error: r.error,
    attempt: r.attempt !== null ? Number(r.attempt) : null,
    statusCode: r.status_code !== null ? Number(r.status_code) : null,
  }));

  const hasData = apiErrorCount > 0 || compactionCount > 0 || retryExhaustionCount > 0;
  return {
    apiErrorCount,
    compactionCount,
    retryExhaustionCount,
    retryThreshold: 10,
    lastErrors,
    hasData,
  };
}
