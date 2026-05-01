import "server-only";
import { generateUsageReport } from "@/lib/usage/aggregator";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { scanSessionDetail } from "@/lib/scanner/claudeConversations";
import { getDb, isDriverLoaded } from "@/lib/db/connection";
import { initDb, type InitResult } from "@/lib/db/migrations";
import {
  loadUsageReportFromSql,
  getDbMaxMtimeMs,
  needsReconcileAfterV3,
} from "./usageFromDb";
import { loadSessionDetailFromDb } from "./sessionDetailFromDb";
import type { UsageReport } from "@/lib/usage/types";
import type { SessionDetail } from "@/lib/types";

// Read-side data façade for /api/usage (and, in later slices, /api/sessions
// and friends). Backend selection is `MINDER_USE_DB=1`; default remains
// the file-parse path that ships in production today.
//
// The DB-backed path falls through to file-parse on any failure (driver
// missing, init failure, getDb null, thrown error during the load) so a
// misconfigured indexer never breaks /api/usage. The fall-through is
// logged once per process so operators can spot a silently-degraded DB
// mode.

const FLAG = "MINDER_USE_DB";

export function dbModeRequested(): boolean {
  return process.env[FLAG] === "1";
}

// Once-per-process schema-readiness gate. `initDb()` runs `quick_check`
// plus a `meta`/`sqlite_master` lookup, which we don't want on every
// /api/usage hit when MINDER_USE_DB=1. Cache the *promise* so concurrent
// first requests share one in-flight init. Same pattern as
// `/api/sql/route.ts`'s `ensureSchemaReady`.
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
  console.warn(`[data] ${FLAG}=1 set but DB-backed path unavailable: ${reason}. Falling back to file-parse.`);
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
  if (!dbModeRequested() || !isDriverLoaded()) return null;
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
 * Single-session detail loader. SQL-backed when `MINDER_USE_DB=1` and
 * the session has a row in the index; otherwise falls back to the
 * file-parse path.
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
