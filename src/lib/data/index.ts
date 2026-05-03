import "server-only";
import { generateUsageReport } from "@/lib/usage/aggregator";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { scanAllSessions, scanSessionDetail } from "@/lib/scanner/claudeConversations";
import { getDb, isDriverLoaded } from "@/lib/db/connection";
import { initDb, type InitResult } from "@/lib/db/migrations";
import {
  loadUsageReportFromSql,
  getDbMaxMtimeMs,
  needsReconcileAfterV3,
} from "./usageFromDb";
import { loadSessionDetailFromDb } from "./sessionDetailFromDb";
import { loadSessionsListFromDb } from "./sessionsListFromDb";
import { loadAgentUsageFromDb } from "./agentsUsageFromDb";
import { loadSkillUsageFromDb } from "./skillsUsageFromDb";
import { loadClaudeUsageStatsFromDb } from "./claudeUsageFromDb";
import type { UsageReport, AgentStats, SkillStats } from "@/lib/usage/types";
import type { SessionDetail, SessionSummary, ClaudeUsageStats } from "@/lib/types";

// Read-side data façade for /api/usage, /api/sessions, and friends.
// Backend selection is `MINDER_USE_DB`; the default is on. Set
// `MINDER_USE_DB=0` to force the legacy file-parse path.
//
// **Failure mode (P2b-9 contract)**: when DB mode is requested and the
// DB is unavailable (driver missing, init failed, connection null,
// load threw), this layer THROWS `DbUnavailableError`. Routes get a
// 500 — which is the right answer for "DB is supposed to work and
// doesn't." The previous behavior (silent fall-through to file-parse,
// `logFallthroughOnce` masking repeats) hid a single transient EBUSY
// during soak that downgraded every read for the rest of the dev
// session.
//
// **Two intentional fall-throughs preserved** — these are correctness
// / UX features, not error masking:
//   1. v3-readiness gate (`needsReconcileAfterV3`): between migration
//      apply and reconcile, `cost_usd` is 0 on every existing row.
//      File-parse keeps numbers honest during the catch-up window.
//   2. Empty-index gate (sessions/agents/skills/claude usage): a
//      brand-new install with the indexer still warming up returns
//      zero rows; falling back keeps the dashboard populated rather
//      than blank during the first scan.

const FLAG = "MINDER_USE_DB";

export function dbModeRequested(): boolean {
  return process.env[FLAG] !== "0";
}

/**
 * Thrown when DB mode is requested but the SQLite backend isn't
 * usable (driver missing, init failed, connection null, or a load
 * function threw). Bubbles to the route, which returns 500.
 *
 * Distinct from a thrown `Error` so callers (and tests) can pattern-
 * match on the failure mode if needed; the default route handler
 * doesn't distinguish — both produce a 500 — but the typed error
 * keeps the contract grep-able.
 *
 * Uses native `Error.cause` (via the `{ cause }` constructor option)
 * so node's default inspect / stack output includes the chained
 * underlying error consistently. Same pattern `migrations.ts` uses.
 */
export class DbUnavailableError extends Error {
  readonly reason: "driver-missing" | "init-failed" | "connection-null" | "load-failed";
  constructor(
    reason: "driver-missing" | "init-failed" | "connection-null" | "load-failed",
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DbUnavailableError";
    this.reason = reason;
  }
}

// Schema-readiness gate. `initDb()` runs `quick_check` plus a
// `meta`/`sqlite_master` lookup, which we don't want on every
// /api/usage hit. Cache the *promise* so concurrent first requests
// share one in-flight init. Same pattern as `/api/sql/route.ts`'s
// `ensureSchemaReady`.
//
// **Failure recovery**: if `initDb()` reports the schema as unavailable
// (driver missing, corruption-quarantine rename failed mid-flight,
// etc.) we DO NOT cache that failure forever. The pre-P2c behavior
// poisoned every subsequent DB-backed read until process restart;
// observed in soak as a single transient `EBUSY` on the corruption-
// quarantine rename silently downgrading every route to file-parse for
// the rest of the dev session. Now: only cache successful inits; on
// failure, clear the cached promise so the next call retries
// `initDb()` from scratch.
//
// In-flight callers always share the same promise (writes only happen
// in `then` after resolution), so there's no thundering-herd risk
// during init itself; the retry only kicks in after the failed promise
// has resolved.
let initPromise: Promise<InitResult> | null = null;
function ensureSchemaReady(): Promise<InitResult> {
  if (initPromise) return initPromise;
  const promise = initDb();
  initPromise = promise;
  promise
    .then((result) => {
      if (!result.available && initPromise === promise) initPromise = null;
    })
    .catch(() => {
      if (initPromise === promise) initPromise = null;
    });
  return promise;
}

// Light, throttled logging for the two INTENTIONAL fall-through
// cases (v3-catch-up, empty-index). These are not bugs — they're
// expected during migration windows and brand-new installs — but
// surfacing them once per process helps an operator spot a stuck
// reconcile or a cold indexer. Distinct map per case so each kind
// of fall-through gets logged once even if the others fire too.
const fallthroughLoggedFor = new Set<string>();
function logIntentionalFallthrough(scope: string, reason: string): void {
  const key = `${scope}:${reason}`;
  if (fallthroughLoggedFor.has(key)) return;
  fallthroughLoggedFor.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[data] ${scope}: DB-backed path fell back to file-parse (${reason}). This is expected during migration / cold-indexer windows; a 500 from the route would mean the DB itself is unhealthy.`
  );
}

export interface UsageBackendMeta {
  /** Which backend produced the report; surfaces in HTTP `X-Minder-Backend`. */
  backend: "db" | "file";
  /** Max input mtime — feeds ETag computation upstream. */
  maxMtimeMs: number;
}

export interface UsageResult {
  report: UsageReport;
  meta: UsageBackendMeta;
}

type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * DB-readiness gate for SQL-backed read paths. Returns the open `db`
 * handle when everything's healthy; THROWS `DbUnavailableError`
 * otherwise. Each callsite still applies its own dimension-specific
 * gates (e.g., the usage path checks `needsReconcileAfterV3` because
 * `cost_usd` is the column at risk during v3 catch-up; session detail
 * doesn't read `cost_usd` so it skips that check).
 *
 * Not exported — consumers go through the public façade functions
 * which decide whether to call this (DB mode) or skip straight to
 * file-parse (`MINDER_USE_DB=0`).
 */
async function getReadyDb(): Promise<DbHandle> {
  if (!isDriverLoaded()) {
    throw new DbUnavailableError(
      "driver-missing",
      "better-sqlite3 driver not loaded — install the optional dep or set MINDER_USE_DB=0 to force file-parse."
    );
  }
  // `initDb()` can both resolve `{available:false}` (its documented
  // failure return) AND reject (e.g. if `quarantineCorruptDb()`
  // ultimately throws on a Windows EBUSY). Both shapes must surface
  // as `DbUnavailableError(reason: 'init-failed')` for the contract
  // to hold; without the try/catch a rejection escapes as a raw
  // Error and pattern-matching callers / tests miss it.
  let init: InitResult;
  try {
    init = await ensureSchemaReady();
  } catch (err) {
    throw new DbUnavailableError(
      "init-failed",
      `SQLite schema init threw: ${(err as Error).message}`,
      err
    );
  }
  if (!init.available) {
    throw new DbUnavailableError(
      "init-failed",
      `SQLite schema init failed: ${init.error?.message ?? "unknown"}`,
      init.error ?? undefined
    );
  }
  const db = await getDb();
  if (!db) {
    throw new DbUnavailableError(
      "connection-null",
      "getDb() returned null after successful init — connection pool drained or disposed."
    );
  }
  return db;
}

/**
 * Wraps a DB load call, converting unexpected throws into
 * `DbUnavailableError(reason: 'load-failed')` so the route handler's
 * uniform error path catches them. Lets `DbUnavailableError`
 * pass through unchanged — those already carry the right shape.
 */
async function callDbLoader<T>(scope: string, loader: () => T | Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof DbUnavailableError) throw err;
    throw new DbUnavailableError(
      "load-failed",
      `${scope}: SQL load failed — ${(err as Error).message}`,
      err as Error
    );
  }
}

/**
 * File-parse usage path. Used when `MINDER_USE_DB=0` (explicit
 * opt-out) or when the v3-readiness gate says the DB rows are mid-
 * migration.
 */
async function runFileUsage(
  period: "today" | "week" | "month" | "all",
  project: string | undefined
): Promise<UsageResult> {
  // `getJsonlMaxMtime()` is captured AFTER report generation —
  // `parseAllSessions` warms the FileCache as a side effect, so a
  // pre-call read returns 0 on a cold process.
  const report = await generateUsageReport(period, project);
  return { report, meta: { backend: "file", maxMtimeMs: getJsonlMaxMtime() } };
}

/**
 * Run the usage report through whichever backend is enabled.
 *
 * - `MINDER_USE_DB=0`: file-parse, returns immediately.
 * - DB mode + healthy DB + reconcile complete: SQL-backed.
 * - DB mode + v3-catch-up window: file-parse fallback (correctness).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getUsage(
  period: "today" | "week" | "month" | "all",
  project?: string
): Promise<UsageResult> {
  if (!dbModeRequested()) return runFileUsage(period, project);

  const db = await getReadyDb();
  if (needsReconcileAfterV3(db)) {
    logIntentionalFallthrough(
      "getUsage",
      "DB awaiting v3 reconcile (cost_usd / category_costs not yet populated)"
    );
    return runFileUsage(period, project);
  }
  const report = await callDbLoader("getUsage", () =>
    loadUsageReportFromSql(db, period, project)
  );
  return { report, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
}

export interface SessionDetailResult {
  detail: SessionDetail | null;
  meta: { backend: "db" | "file" };
}

/**
 * Single-session detail loader.
 *
 * - `MINDER_USE_DB=0`: file-parse, returns immediately.
 * - DB mode + healthy DB + reconcile complete + session indexed:
 *   SQL-backed.
 * - DB mode + v3-catch-up window: file-parse fallback (correctness —
 *   `cost_usd` and one-shot counts are the at-risk columns).
 * - DB mode + session not indexed yet: file-parse fallback (a session
 *   that exists on disk but hasn't been ingested still resolves).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getSessionDetail(sessionId: string): Promise<SessionDetailResult> {
  if (!dbModeRequested()) {
    const detail = await scanSessionDetail(sessionId);
    return { detail, meta: { backend: "file" } };
  }

  const db = await getReadyDb();
  if (needsReconcileAfterV3(db)) {
    logIntentionalFallthrough(
      "getSessionDetail",
      "DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)"
    );
    const detail = await scanSessionDetail(sessionId);
    return { detail, meta: { backend: "file" } };
  }
  const dbDetail = await callDbLoader("getSessionDetail", () =>
    loadSessionDetailFromDb(db, sessionId)
  );
  if (dbDetail) return { detail: dbDetail, meta: { backend: "db" } };

  // Session not in the index — fall through to file-parse so a
  // newly-arrived JSONL still resolves before the indexer catches it.
  // This is a per-session miss, not a DB unavailability — no
  // `logIntentionalFallthrough` (it'd fire constantly during normal
  // browsing of un-indexed sessions).
  const detail = await scanSessionDetail(sessionId);
  return { detail, meta: { backend: "file" } };
}

export interface SessionsListResult {
  sessions: SessionSummary[];
  meta: { backend: "db" | "file"; maxMtimeMs: number };
}

/**
 * Cross-project session list.
 *
 * - `MINDER_USE_DB=0`: file-parse.
 * - DB mode + healthy DB + reconcile complete + non-empty index:
 *   SQL-backed.
 * - DB mode + v3-catch-up: file-parse (correctness).
 * - DB mode + empty index: file-parse (UX — brand-new install
 *   still surfaces sessions while the indexer warms up).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 *
 * Project filtering is intentionally NOT pushed into this layer —
 * the route caches the unfiltered set so back-to-back "all
 * projects" then "single project" navigation reuses the cache.
 * Matches the file-parse route's existing post-cache filter pattern.
 */
export async function getSessionsList(): Promise<SessionsListResult> {
  if (!dbModeRequested()) return runFileSessionsList();

  const db = await getReadyDb();
  if (needsReconcileAfterV3(db)) {
    logIntentionalFallthrough(
      "getSessionsList",
      "DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)"
    );
    return runFileSessionsList();
  }
  const sessions = await callDbLoader("getSessionsList", () =>
    loadSessionsListFromDb(db)
  );
  if (sessions.length === 0) {
    logIntentionalFallthrough("getSessionsList", "DB index empty (indexer warming up?)");
    return runFileSessionsList();
  }
  return { sessions, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
}

async function runFileSessionsList(): Promise<SessionsListResult> {
  const sessions = await scanAllSessions();
  // `getJsonlMaxMtime()` only reflects files parsed by `parseAllSessions`
  // (the usage parser's FileCache); `scanAllSessions` doesn't warm that
  // cache, so a cold call here would return 0 — useless as an ETag input.
  // Derive a content-driven watermark from the sessions array's
  // endTime/startTime fields, matching the `deriveMaxSessionMs` shape
  // the route already uses for its own ETag inputs.
  return {
    sessions,
    meta: { backend: "file", maxMtimeMs: deriveSessionsMaxMs(sessions) },
  };
}

function deriveSessionsMaxMs(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const ts = s.endTime ?? s.startTime;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

export interface AgentUsageResult {
  stats: AgentStats[];
  meta: { backend: "db" | "file" };
}

/**
 * Cross-project agent (subagent) usage stats.
 *
 * - `MINDER_USE_DB=0`: file-parse.
 * - DB mode + healthy DB + non-empty Agent rows: SQL-backed. No v3
 *   gate — this path doesn't read `cost_usd` or one-shot counts.
 * - DB mode + zero Agent rows: file-parse fallback (UX — keeps the
 *   agents page populated until the indexer catches up).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getAgentUsage(): Promise<AgentUsageResult> {
  if (!dbModeRequested()) return runFileAgentUsage();

  const db = await getReadyDb();
  const stats = await callDbLoader("getAgentUsage", () => loadAgentUsageFromDb(db));
  if (stats.length === 0) {
    logIntentionalFallthrough("getAgentUsage", "DB has zero Agent rows (indexer warming up?)");
    return runFileAgentUsage();
  }
  return { stats, meta: { backend: "db" } };
}

async function runFileAgentUsage(): Promise<AgentUsageResult> {
  // Lazy-import the file-parse pipeline to keep the DB happy-path off
  // the import graph for `parseAllSessions` / `groupAgentCalls` —
  // under normal operation we never load them.
  const { parseAllSessions } = await import("@/lib/usage/parser");
  const { groupAgentCalls } = await import("@/lib/usage/agentParser");
  const sessionMap = await parseAllSessions();
  const allTurns = Array.from(sessionMap.values()).flat();
  const stats = groupAgentCalls(allTurns);
  return { stats, meta: { backend: "file" } };
}

export interface SkillUsageResult {
  stats: SkillStats[];
  meta: { backend: "db" | "file" };
}

/**
 * Cross-project skill usage stats. Mirror of `getAgentUsage` against
 * `tool_uses.skill_name`.
 *
 * - `MINDER_USE_DB=0`: file-parse.
 * - DB mode + healthy DB + non-empty Skill rows: SQL-backed. No v3
 *   gate — pure tool_uses aggregation, no cost columns.
 * - DB mode + zero Skill rows: file-parse fallback (UX).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getSkillUsage(): Promise<SkillUsageResult> {
  if (!dbModeRequested()) return runFileSkillUsage();

  const db = await getReadyDb();
  const stats = await callDbLoader("getSkillUsage", () => loadSkillUsageFromDb(db));
  if (stats.length === 0) {
    logIntentionalFallthrough("getSkillUsage", "DB has zero Skill rows (indexer warming up?)");
    return runFileSkillUsage();
  }
  return { stats, meta: { backend: "db" } };
}

async function runFileSkillUsage(): Promise<SkillUsageResult> {
  const { parseAllSessions } = await import("@/lib/usage/parser");
  const { groupSkillCalls } = await import("@/lib/usage/skillParser");
  const sessionMap = await parseAllSessions();
  const allTurns = Array.from(sessionMap.values()).flat();
  const stats = groupSkillCalls(allTurns);
  return { stats, meta: { backend: "file" } };
}

export interface ClaudeUsageResult {
  stats: ClaudeUsageStats;
  meta: {
    backend: "db" | "file";
    /**
     * Max content-mtime watermark for ETag computation.
     * - DB backend: `MAX(file_mtime_ms) FROM sessions` — fresh and
     *   accurate; advances on every JSONL tail-append the indexer
     *   processes.
     * - File backend: `0` (the file-parse pipeline doesn't expose a
     *   max-mtime cheaply). Caller is expected to fall back to its
     *   own freshness signal — `/api/stats` uses `result.scannedAt`.
     */
    maxMtimeMs: number;
  };
}

/**
 * Aggregate Claude conversation stats scoped to the given project
 * paths.
 *
 * - `MINDER_USE_DB=0`: file-parse.
 * - DB mode + healthy DB + reconcile complete + non-empty conversations:
 *   SQL-backed.
 * - DB mode + v3-catch-up: file-parse (correctness — reads `cost_usd`).
 * - DB mode + zero conversations for the filter set: file-parse (UX).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getClaudeUsage(projectPaths: string[]): Promise<ClaudeUsageResult> {
  if (!dbModeRequested()) return runFileClaudeUsage(projectPaths);

  const db = await getReadyDb();
  if (needsReconcileAfterV3(db)) {
    logIntentionalFallthrough(
      "getClaudeUsage",
      "DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)"
    );
    return runFileClaudeUsage(projectPaths);
  }
  const stats = await callDbLoader("getClaudeUsage", () =>
    loadClaudeUsageStatsFromDb(db, projectPaths)
  );
  if (stats.conversationCount === 0) {
    logIntentionalFallthrough(
      "getClaudeUsage",
      "DB has zero conversations for the filter set (indexer warming up?)"
    );
    return runFileClaudeUsage(projectPaths);
  }
  return { stats, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
}

async function runFileClaudeUsage(projectPaths: string[]): Promise<ClaudeUsageResult> {
  const { scanClaudeConversationsForProjects } = await import(
    "@/lib/scanner/claudeConversations"
  );
  const stats = await scanClaudeConversationsForProjects(projectPaths);
  // File backend doesn't carry a cheap max-mtime watermark; route
  // is expected to fall back to its own freshness signal (see
  // `ClaudeUsageResult.meta.maxMtimeMs` JSDoc).
  return { stats, meta: { backend: "file", maxMtimeMs: 0 } };
}
