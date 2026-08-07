import "server-only";
import type DatabaseT from "better-sqlite3";
import { getDb, prepCached } from "./connection";
import type { Period } from "../telemetryPeriod";
import { periodToMs } from "../telemetryPeriod";

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

// Re-exported from a client-safe module so client components can import
// `periodToMs`/`periodToSince` as values without dragging `server-only` — and
// better-sqlite3 behind it — into the browser bundle. See lib/telemetryPeriod.ts.
export type { Period } from "../telemetryPeriod";
export { periodToMs, periodToSince } from "../telemetryPeriod";

// otel_events.ts is TEXT (ISO-8601); comparison with toISOString() strings is safe.
function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Nearest-rank percentile over a value→count histogram: the value at 1-based
 * rank `ceil(p/100 * total)`.
 *
 * Expressed over counts rather than an expanded array so a caller can aggregate
 * in SQL and stay bounded by *distinct* values rather than by row count, without
 * changing any number it would otherwise report. This is now the only percentile
 * in this module — the array-based twin it was written to match became dead once
 * `getToolLatency` and `getHookActivity` both stopped reading raw rows.
 *
 * The same rule is reimplemented in `lib/sessions/hookSummary.ts`, which cannot
 * import from here (this module is `server-only` and that one renders on the
 * client); the duplication is deliberate and noted in both places so a session's
 * p50 and the Stats card's p50 keep meaning the same thing.
 */
function percentileFromHistogram(
  sorted: { value: number; count: number }[],
  total: number,
  p: number
): number {
  if (total === 0 || sorted.length === 0) return 0;
  const rank = Math.min(Math.max(1, Math.ceil((p / 100) * total)), total);
  let seen = 0;
  for (const { value, count } of sorted) {
    seen += count;
    if (seen >= rank) return value;
  }
  return sorted[sorted.length - 1].value;
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

  // SQLite lacks PERCENTILE_CONT, so the percentiles are computed in JS — but
  // over a histogram, not a raw row list.
  //
  // This used to `ORDER BY ts DESC LIMIT 50000` and aggregate the result,
  // truncating before grouping exactly as `getHookActivity` did: past the cap
  // the newest rows won and everything older vanished, so `n`, `errorRate` and
  // both percentiles described a recent suffix while presenting themselves as
  // the whole period. The old comment called the accuracy loss "negligible at
  // that scale", which was never measured — it is not a sampling error, it is
  // a different (recent) population, and `n` is reported to the user as the
  // sample size.
  //
  // Left latent until the Telemetry period toggle made `30d` and `all`
  // selectable from the UI. Measured on the reference index when fixed: 34,488
  // rows all-history against a 50,000 cap — under it, but growing ~1,020/day,
  // so roughly two weeks from silently truncating.
  //
  // Grouping by (tool, duration, success) compresses 2.61x here and, more to
  // the point, is bounded by *distinct* values rather than by row count, so it
  // cannot silently truncate at any corpus size.
  const rows = prepCached(
    db,
    `SELECT
       JSON_EXTRACT(payload_json, '$.attrs.tool_name') AS tool_name,
       CAST(JSON_EXTRACT(payload_json, '$.attrs.duration_ms') AS REAL) AS duration_ms,
       JSON_EXTRACT(payload_json, '$.attrs.success') AS success,
       COUNT(*) AS n
     FROM otel_events
     WHERE ${conditions.join(" AND ")}
       AND JSON_EXTRACT(payload_json, '$.attrs.duration_ms') IS NOT NULL
     GROUP BY tool_name, duration_ms, success`,
  ).all(...params) as { tool_name: string; duration_ms: number; success: string; n: number }[];

  // Durations keyed by value so the success/failure split collapses back
  // together for the percentiles — a 20ms success and a 20ms failure are two
  // observations of 20ms, and grouping by all three columns had them arrive as
  // separate rows.
  const byTool = new Map<string, { durations: Map<number, number>; errors: number; n: number }>();
  for (const row of rows) {
    if (!row.tool_name || !Number.isFinite(row.duration_ms)) continue;
    const entry = byTool.get(row.tool_name) ?? { durations: new Map(), errors: 0, n: 0 };
    entry.durations.set(row.duration_ms, (entry.durations.get(row.duration_ms) ?? 0) + row.n);
    entry.n += row.n;
    if (row.success !== "true") entry.errors += row.n;
    byTool.set(row.tool_name, entry);
  }

  const tools: ToolLatencyRow[] = [];
  for (const [name, { durations, errors, n }] of byTool) {
    const sorted = [...durations.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value - b.value);
    tools.push({
      name,
      p50: Math.round(percentileFromHistogram(sorted, n, 50)),
      p95: Math.round(percentileFromHistogram(sorted, n, 95)),
      max: Math.round(sorted[sorted.length - 1]?.value ?? 0),
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
  /**
   * Undefined when NO occurrence of this hook carried a duration.
   *
   * Not zero. This slice's headline principle is that an unmeasured hook must
   * not be rendered as an instant one, and returning `0` here broke it in the
   * same PR that stated it — a completely unmeasured command would have sorted
   * as the fastest on the machine (Codex + Copilot review of #386).
   */
  p50DurationMs?: number;
  p95DurationMs?: number;
  /** How many of `fires` actually carried a duration. `0` means the percentiles are absent. */
  measuredFires?: number;
}

export interface HookActivityResult {
  hooks: HookRow[];
  totalFires: number;
  hasData: boolean;
  /**
   * Where the numbers came from.
   *
   * `otel` — `hook_execution_complete` events, which require OTEL telemetry to
   * have been enabled and only cover the period since it was.
   * `transcript` — `session_hook_runs`, decoded from `hookInfos` on system
   * entries. Needs no setup and covers all history retroactively.
   *
   * Never blended: OTEL names a hook (`PreToolUse`), the transcript names the
   * command it ran (`codegraph sync`), so the two key on different things and
   * merging them would double-count under two different labels.
   */
  source?: "otel" | "transcript";
}

/**
 * Which pipeline to read hook latency from.
 *
 * `auto` prefers OTEL and falls back to the transcript only when OTEL returns
 * nothing — the long-standing behaviour, and still the default.
 *
 * The explicit values exist because `auto` makes the transcript source
 * *unreachable* once OTEL has any data: `since` is a lower bound, so every
 * window ending at now includes recent events, and no choice of period falls
 * back. The two are not interchangeable views of one dataset — OTEL keys on the
 * hook name, the transcript on the command that ran — so "show me the other
 * one" has to be asked for directly rather than approximated with a date range
 * (Codex review of #402, which caught documentation promising this was already
 * possible).
 */
export type HookActivitySource = "auto" | "otel" | "transcript";

export async function getHookActivity(opts: {
  since: number;
  source?: HookActivitySource;
}): Promise<HookActivityResult> {
  const db = await getDb();
  if (!db) return { hooks: [], totalFires: 0, hasData: false };

  const sinceIso = msToIso(opts.since);
  const source = opts.source ?? "auto";

  // Asked for the transcript explicitly: never consult OTEL, and never fall
  // forward to it when the transcript is empty. An empty answer for the source
  // the caller named is the truthful one; silently substituting the other
  // pipeline would return rows keyed on something else entirely.
  if (source === "transcript") {
    return getHookActivityFromTranscripts(db, sinceIso, opts.since <= 0);
  }

  // Grouped in SQL, for the same reason the transcript fallback below is.
  //
  // This used to `SELECT hook_name, duration_ms … ORDER BY ts DESC LIMIT 10000`
  // and aggregate in JS, which truncated exactly the way the fallback's old
  // `LIMIT 50000` did — the newest 10,000 rows survived and everything older
  // was dropped BEFORE grouping. On the local corpus that is 10,000 of 80,824
  // rows (12%) and 104 of 193 hook names, reported as if it were the whole
  // period: `totalFires` read a suspiciously round 10000 for `7d`, `30d` and
  // `all` alike, because the cap — not the window — decided the answer.
  //
  // A6 fixed this in the fallback and left the identical defect in the primary
  // path, where it mattered more: OTEL wins whenever any hook event exists, so
  // this is the branch nearly every machine with telemetry actually renders.
  //
  // The histogram keeps the result bounded without capping: one row per
  // distinct (hook_name, duration) pair — 46,102 here against 80,824 rows —
  // while the counts still describe every fire in the period.
  const rows = prepCached(
    db,
    `SELECT
       JSON_EXTRACT(payload_json, '$.attrs.hook_name') AS hook_name,
       CAST(JSON_EXTRACT(payload_json, '$.attrs.total_duration_ms') AS REAL) AS duration_ms,
       COUNT(*) AS n
     FROM otel_events
     WHERE event_name = 'hook_execution_complete'
       AND ts >= ?
       AND JSON_EXTRACT(payload_json, '$.attrs.hook_name') IS NOT NULL
     GROUP BY hook_name, duration_ms`,
  ).all(sinceIso) as { hook_name: string; duration_ms: number | null; n: number }[];

  const byHook = new Map<
    string,
    { measured: { value: number; count: number }[]; measuredFires: number; fires: number }
  >();
  for (const row of rows) {
    if (!row.hook_name) continue;
    const cur = byHook.get(row.hook_name) ?? { measured: [], measuredFires: 0, fires: 0 };
    // A fire with no usable duration still happened. It used to be dropped from
    // `fires` entirely, so a hook OTEL timed inconsistently under-reported its
    // own frequency; `measuredFires` is what carries the distinction. Every
    // `hook_execution_complete` row on this corpus does carry the attribute, so
    // this costs nothing today and stops lying if that ever changes.
    cur.fires += row.n;
    if (Number.isFinite(row.duration_ms as number)) {
      cur.measured.push({ value: row.duration_ms as number, count: row.n });
      cur.measuredFires += row.n;
    }
    byHook.set(row.hook_name, cur);
  }

  const hooks: HookRow[] = [];
  let totalFires = 0;
  for (const [name, v] of byHook) {
    const sorted = v.measured.slice().sort((a, b) => a.value - b.value);
    hooks.push({
      name,
      fires: v.fires,
      measuredFires: v.measuredFires,
      // Omitted entirely when nothing was measured — see HookRow.
      ...(v.measuredFires
        ? {
            p50DurationMs: Math.round(percentileFromHistogram(sorted, v.measuredFires, 50)),
            p95DurationMs: Math.round(percentileFromHistogram(sorted, v.measuredFires, 95)),
          }
        : {}),
    });
    totalFires += v.fires;
  }
  hooks.sort((a, b) => b.fires - a.fires);

  if (hooks.length > 0) {
    return { hooks, totalFires, hasData: true, source: "otel" };
  }

  // Asked for OTEL explicitly: report the empty result rather than falling back.
  if (source === "otel") {
    return { hooks: [], totalFires: 0, hasData: false, source: "otel" };
  }

  // No OTEL hook events. That is the DEFAULT state, not an edge case: OTEL is
  // opt-in, so for anyone who hasn't enabled it this tool returned an empty
  // result that reads as "you have no hooks" rather than "I can't see them".
  // The transcript carries the same measurement for free — and retroactively.
  // `since <= 0` is how the callers spell "all history" (the period switcher
  // maps `all` to epoch 0). Passed through rather than re-derived from the ISO
  // string, which would mean string-comparing against 1970.
  return getHookActivityFromTranscripts(db, sinceIso, opts.since <= 0);
}

/**
 * Hook latency from `session_hook_runs`, the transcript-derived table.
 *
 * Rows with a NULL `duration_ms` are counted as fires but excluded from the
 * percentiles — Claude Code records a command with no duration for roughly a
 * fifth of hook records, and treating "not measured" as 0 ms would drag every
 * percentile toward zero and rank the unmeasured hooks fastest.
 */
async function getHookActivityFromTranscripts(
  db: DatabaseT.Database,
  sinceIso: string,
  allHistory: boolean
): Promise<HookActivityResult> {
  // Grouped in SQL rather than read row-by-row.
  //
  // This used to `SELECT command, duration_ms … ORDER BY ts DESC LIMIT 50000`
  // and aggregate the result in JS, which silently truncated: on an `all` or a
  // busy 30-day window with more than 50,000 runs, the newest rows were kept
  // and everything older was dropped BEFORE grouping — so `fires`, `totalFires`
  // and both percentiles described a suffix of the period while the fallback's
  // contract promises all of it. A partial answer shaped exactly like a
  // complete one (Codex review, #386).
  //
  // A histogram rather than a raw list keeps the result bounded without
  // capping: one row per distinct (command, duration) pair, which is small
  // because durations are integer milliseconds and hooks are repetitive, while
  // the counts still describe every run in the period.
  // A run with no timestamp is a supported row, not a malformed one: ingest
  // stores `entry.timestamp ?? null` and `SessionHookRun.ts` is optional. But
  // `ts >= ?` is false for NULL, so every untimestamped run vanished from
  // `fires`, `totalFires` and the percentiles — including on `all`, where the
  // predicate degrades to `ts >= '1970-01-01…'` and excludes them anyway. The
  // same all-history contract the row cap was breaking, broken a second way
  // (Codex review, #386).
  //
  // Only all-history takes them. For a bounded period the honest answer is to
  // leave them out: nothing places an undated run inside a window, and
  // assigning it to one would be a guess reported as a measurement.
  const rows = prepCached(
    db,
    allHistory
      ? `SELECT command, duration_ms, COUNT(*) AS n
           FROM session_hook_runs
          WHERE ts >= ? OR ts IS NULL
          GROUP BY command, duration_ms`
      : `SELECT command, duration_ms, COUNT(*) AS n
           FROM session_hook_runs
          WHERE ts >= ?
          GROUP BY command, duration_ms`
  ).all(sinceIso) as { command: string; duration_ms: number | null; n: number }[];

  const byHook = new Map<
    string,
    { measured: { value: number; count: number }[]; measuredFires: number; fires: number }
  >();
  for (const row of rows) {
    if (!row.command) continue;
    const cur = byHook.get(row.command) ?? { measured: [], measuredFires: 0, fires: 0 };
    cur.fires += row.n;
    if (Number.isFinite(row.duration_ms as number)) {
      cur.measured.push({ value: row.duration_ms as number, count: row.n });
      cur.measuredFires += row.n;
    }
    byHook.set(row.command, cur);
  }

  const hooks: HookRow[] = [];
  let totalFires = 0;
  for (const [name, v] of byHook) {
    const sorted = v.measured.slice().sort((a, b) => a.value - b.value);
    hooks.push({
      name,
      fires: v.fires,
      measuredFires: v.measuredFires,
      // Omitted entirely when nothing was measured — see HookRow.
      ...(v.measuredFires
        ? {
            p50DurationMs: Math.round(percentileFromHistogram(sorted, v.measuredFires, 50)),
            p95DurationMs: Math.round(percentileFromHistogram(sorted, v.measuredFires, 95)),
          }
        : {}),
    });
    totalFires += v.fires;
  }
  hooks.sort((a, b) => b.fires - a.fires);
  return { hooks, totalFires, hasData: hooks.length > 0, source: "transcript" };
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

// ── Raw event/metric query (MCP surface) ──────────────────────────────────────
// Lower-level peek at otel_events / otel_metrics for callers (the MCP server)
// that want to slice raw rows in ways the derived helpers above don't cover.

export interface RawOtelEvent {
  id: number;
  ts: string;
  sessionId: string | null;
  eventName: string;
  payload: unknown;
}

export interface QueryEventsOpts {
  since?: number;
  until?: number;
  eventName?: string;
  sessionId?: string;
  limit?: number;
}

export async function queryOtelEvents(opts: QueryEventsOpts = {}): Promise<RawOtelEvent[]> {
  const db = await getDb();
  if (!db) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.since !== undefined) {
    conditions.push(`ts >= ?`);
    params.push(msToIso(opts.since));
  }
  if (opts.until !== undefined) {
    conditions.push(`ts <= ?`);
    params.push(msToIso(opts.until));
  }
  if (opts.eventName) {
    conditions.push(`event_name = ?`);
    params.push(opts.eventName);
  }
  if (opts.sessionId) {
    conditions.push(`session_id = ?`);
    params.push(opts.sessionId);
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = prepCached(
    db,
    `SELECT id, ts, session_id, event_name, payload_json
     FROM otel_events
     ${where}
     ORDER BY ts DESC
     LIMIT ?`
  ).all(...params, limit) as Array<{
    id: number;
    ts: string;
    session_id: string | null;
    event_name: string;
    payload_json: string;
  }>;

  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = r.payload_json;
    }
    return {
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      eventName: r.event_name,
      payload,
    };
  });
}

export interface RawOtelMetric {
  id: number;
  ts: number;
  sessionId: string | null;
  metricName: string;
  metricType: "counter" | "gauge";
  value: number;
  model: string | null;
  attrs: unknown;
}

export interface QueryMetricsOpts {
  since?: number;
  until?: number;
  metricName?: string;
  sessionId?: string;
  limit?: number;
}

export async function queryOtelMetrics(opts: QueryMetricsOpts = {}): Promise<RawOtelMetric[]> {
  const db = await getDb();
  if (!db) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];
  // otel_metrics.ts is INTEGER ms — direct comparison, no msToIso conversion.
  if (opts.since !== undefined) {
    conditions.push(`ts >= ?`);
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    conditions.push(`ts <= ?`);
    params.push(opts.until);
  }
  if (opts.metricName) {
    conditions.push(`metric_name = ?`);
    params.push(opts.metricName);
  }
  if (opts.sessionId) {
    conditions.push(`session_id = ?`);
    params.push(opts.sessionId);
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = prepCached(
    db,
    `SELECT id, ts, session_id, metric_name, metric_type, value, model, attrs_json
     FROM otel_metrics
     ${where}
     ORDER BY ts DESC
     LIMIT ?`
  ).all(...params, limit) as Array<{
    id: number;
    ts: number;
    session_id: string | null;
    metric_name: string;
    metric_type: "counter" | "gauge";
    value: number;
    model: string | null;
    attrs_json: string | null;
  }>;

  return rows.map((r) => {
    let attrs: unknown = null;
    if (r.attrs_json) {
      try {
        attrs = JSON.parse(r.attrs_json);
      } catch {
        attrs = r.attrs_json;
      }
    }
    return {
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      metricName: r.metric_name,
      metricType: r.metric_type,
      value: r.value,
      model: r.model,
      attrs,
    };
  });
}
