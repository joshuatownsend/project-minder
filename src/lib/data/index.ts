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
import type { UsageReport, AgentStats } from "@/lib/usage/types";
import type { SessionDetail, SessionSummary } from "@/lib/types";

// Read-side data façade for /api/usage, /api/sessions, and friends.
// Backend selection is `MINDER_USE_DB`; the default is on. Set
// `MINDER_USE_DB=0` to force the legacy file-parse path (e.g. to debug
// a regression).
//
// The DB-backed path falls through to file-parse on any failure (driver
// missing, init failure, getDb null, thrown error during the load) so a
// misconfigured indexer never breaks /api/usage. The fall-through is
// logged once per process so operators can spot a silently-degraded DB
// mode.

const FLAG = "MINDER_USE_DB";

export function dbModeRequested(): boolean {
  return process.env[FLAG] !== "0";
}

// Once-per-process schema-readiness gate. `initDb()` runs `quick_check`
// plus a `meta`/`sqlite_master` lookup, which we don't want on every
// /api/usage hit. Cache the *promise* so concurrent first requests
// share one in-flight init. Same pattern as `/api/sql/route.ts`'s
// `ensureSchemaReady`.
let initPromise: Promise<InitResult> | null = null;
function ensureSchemaReady(): Promise<InitResult> {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

let fallthroughLogged = false;
function logFallthroughOnce(reason: string): void {
  if (fallthroughLogged) return;
  fallthroughLogged = true;
  // eslint-disable-next-line no-console
  console.warn(`[data] DB-backed path unavailable: ${reason}. Falling back to file-parse. Set ${FLAG}=0 to skip the DB path entirely.`);
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
 * Common DB-readiness gate for SQL-backed read paths. Returns the open
 * `db` handle when everything's healthy, or `null` to signal "fall back
 * to file-parse" — same contract every consumer follows. Each callsite
 * still applies its own dimension-specific gates (e.g., the usage path
 * checks `needsReconcileAfterV3` because `cost_usd` is the column at
 * risk during v3 catch-up; session detail doesn't read `cost_usd` so
 * it skips that check).
 */
async function getReadyDb(): Promise<DbHandle | null> {
  // User explicitly opted out (MINDER_USE_DB=0) — silent fall-through.
  // Not a degradation case; the operator knows.
  if (!dbModeRequested()) return null;
  // Driver missing IS a silent-degradation case — DB mode was requested
  // (default-on or explicit =1) but better-sqlite3 isn't loadable. Log
  // once so operators can spot the configuration gap.
  if (!isDriverLoaded()) {
    logFallthroughOnce("better-sqlite3 driver not loaded");
    return null;
  }
  const init = await ensureSchemaReady();
  if (!init.available) {
    logFallthroughOnce(init.error?.message ?? "schema unavailable");
    return null;
  }
  const db = await getDb();
  if (!db) {
    logFallthroughOnce("getDb returned null after init");
    return null;
  }
  return db;
}

/**
 * Try the SQLite-backed path. Returns `null` (caller falls back to
 * file-parse) on any failure or unmet precondition. Each guard takes
 * a single early-return; the happy path is the unindented bottom.
 */
async function tryDbBackend(
  period: "today" | "week" | "month" | "all",
  project: string | undefined
): Promise<UsageResult | null> {
  try {
    const db = await getReadyDb();
    if (!db) return null;
    // v3 readiness gate: between migration apply and reconcile,
    // `turns.cost_usd` is 0 on every existing row. Without this guard
    // the SQL aggregate would return totalCost = $0 — a silent wrong
    // answer. Cleared by `reconcileAllSessions` on success.
    if (needsReconcileAfterV3(db)) {
      logFallthroughOnce("DB awaiting v3 reconcile (cost_usd / category_costs not yet populated)");
      return null;
    }
    const report = loadUsageReportFromSql(db, period, project);
    return { report, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
  } catch (err) {
    logFallthroughOnce((err as Error).message);
    return null;
  }
}

/**
 * Run the usage report through whichever backend is enabled. Always
 * returns a valid `UsageReport` — the DB backend transparently falls
 * back to file-parse on any failure.
 */
export async function getUsage(
  period: "today" | "week" | "month" | "all",
  project?: string
): Promise<UsageResult> {
  const dbResult = await tryDbBackend(period, project);
  if (dbResult) return dbResult;

  // File-parse backend. `getJsonlMaxMtime()` is captured AFTER report
  // generation — `parseAllSessions` warms the FileCache as a side
  // effect, so a pre-call read returns 0 on a cold process.
  const report = await generateUsageReport(period, project);
  return { report, meta: { backend: "file", maxMtimeMs: getJsonlMaxMtime() } };
}

export interface SessionDetailResult {
  detail: SessionDetail | null;
  meta: { backend: "db" | "file" };
}

/**
 * Single-session detail loader. SQL-backed by default when the
 * session has a row in the index; otherwise falls back to the
 * file-parse path. Set `MINDER_USE_DB=0` to force the legacy path.
 *
 * The v3 readiness gate applies here too: `loadSessionDetailFromDb`
 * reads `sessions.cost_usd` (→ `costEstimate`) and
 * `verified_task_count` / `one_shot_task_count` (→ `oneShotRate`),
 * which are 0 on un-reconciled rows during the v3 catch-up window.
 * Without the gate the DB backend would silently serve $0 and
 * `oneShotRate=undefined` for a half-reconciled corpus while the
 * file-parse path returns the right numbers.
 *
 * The DB path returns `null` when the session isn't indexed (vs.
 * "indexed but not found"). The façade treats `null` as "fall through
 * to file-parse" so a session that exists on disk but hasn't been
 * indexed yet still resolves.
 */
export async function getSessionDetail(sessionId: string): Promise<SessionDetailResult> {
  const dbDetail = await tryDbSessionDetail(sessionId);
  if (dbDetail) return { detail: dbDetail, meta: { backend: "db" } };

  const detail = await scanSessionDetail(sessionId);
  return { detail, meta: { backend: "file" } };
}

async function tryDbSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  try {
    const db = await getReadyDb();
    if (!db) return null;
    if (needsReconcileAfterV3(db)) {
      logFallthroughOnce("DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)");
      return null;
    }
    return loadSessionDetailFromDb(db, sessionId);
  } catch (err) {
    logFallthroughOnce((err as Error).message);
    return null;
  }
}

export interface SessionsListResult {
  sessions: SessionSummary[];
  meta: { backend: "db" | "file"; maxMtimeMs: number };
}

/**
 * Cross-project session list. SQL-backed by default when the index has
 * sessions; falls back to `scanAllSessions` (file-parse) on driver-missing,
 * init-failure, awaiting-v3 reconcile, empty index, or any thrown error.
 *
 * The empty-index case is treated as a fall-through (rather than returning
 * an empty list) so a brand-new install with the indexer still warming up
 * still surfaces sessions on the dashboard. The two backends produce the
 * same SessionSummary shape modulo seven documented divergences listed in
 * `sessionsListFromDb.ts`'s header comment.
 *
 * Project filtering is intentionally NOT pushed into this layer — the
 * route caches the unfiltered set so a back-to-back "all projects" then
 * "single project" navigation reuses the same cache. Matches the file-
 * parse route's existing post-cache filter pattern.
 */
export async function getSessionsList(): Promise<SessionsListResult> {
  const dbResult = await tryDbSessionsList();
  if (dbResult) return dbResult;

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

async function tryDbSessionsList(): Promise<SessionsListResult | null> {
  try {
    const db = await getReadyDb();
    if (!db) return null;
    // Apply the v3 readiness gate uniformly with the other DB-backed
    // paths: `sessions.cost_usd` is `0` until reconcile re-derives it,
    // and the per-session `costEstimate` shown in cards would silently
    // collapse to $0 without this check during the catch-up window.
    if (needsReconcileAfterV3(db)) {
      logFallthroughOnce("DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)");
      return null;
    }
    const sessions = loadSessionsListFromDb(db);
    if (sessions.length === 0) {
      // Empty index — likely indexer still warming up on a new install.
      // Fall through to file-parse so the dashboard isn't blank.
      return null;
    }
    return {
      sessions,
      meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) },
    };
  } catch (err) {
    logFallthroughOnce((err as Error).message);
    return null;
  }
}

export interface AgentUsageResult {
  stats: AgentStats[];
  meta: { backend: "db" | "file" };
}

/**
 * Cross-project agent (subagent) usage stats. SQL-backed by default
 * when `tool_uses` carries Agent rows; falls back to the file-parse
 * `parseAllSessions` + `groupAgentCalls` path on driver-missing,
 * init-failure, empty index, or any thrown error.
 *
 * No v3 readiness gate here — this path doesn't read `cost_usd` or
 * one-shot counts; the agent stats derive purely from indexed
 * `tool_uses` rows that are populated at the same time as the rest
 * of the session.
 *
 * Empty-index fall-through (same posture as `getSessionsList`): if
 * the indexer has zero Agent rows but JSONL files exist on disk,
 * file-parse keeps the agents page populated until the indexer
 * catches up. The route caller doesn't need to know which backend
 * served — `meta.backend` and the `X-Minder-Backend` header surface
 * it for soak monitoring.
 */
export async function getAgentUsage(): Promise<AgentUsageResult> {
  const dbResult = await tryDbAgentUsage();
  if (dbResult) return dbResult;

  // File-parse fall-through. Lazy-import the file-parse pipeline to
  // keep the DB happy-path off the import graph for `parseAllSessions`
  // / `groupAgentCalls` — under normal operation we never load them.
  const { parseAllSessions } = await import("@/lib/usage/parser");
  const { groupAgentCalls } = await import("@/lib/usage/agentParser");
  const sessionMap = await parseAllSessions();
  const allTurns = Array.from(sessionMap.values()).flat();
  const stats = groupAgentCalls(allTurns);
  return { stats, meta: { backend: "file" } };
}

async function tryDbAgentUsage(): Promise<AgentUsageResult | null> {
  try {
    const db = await getReadyDb();
    if (!db) return null;
    const stats = loadAgentUsageFromDb(db);
    if (stats.length === 0) return null;
    return { stats, meta: { backend: "db" } };
  } catch (err) {
    logFallthroughOnce((err as Error).message);
    return null;
  }
}
