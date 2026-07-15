import "server-only";
import { generateUsageReport, augmentPortfolioYield } from "@/lib/usage/aggregator";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { scanAllSessions, scanSessionDetail } from "@/lib/scanner/claudeConversations";
import { getSessionMeta } from "@/lib/scanner/claudeStats";
import { getDb, isDriverLoaded } from "@/lib/db/connection";
import { initDb, type InitResult } from "@/lib/db/migrations";
import {
  loadUsageReportFromSql,
  compareUsageFromSql,
  buildNotComparable,
  getDbMaxMtimeMs,
  needsReconcileAfterV3,
} from "./usageFromDb";
import { loadSessionDetailFromDb } from "./sessionDetailFromDb";
import { loadSessionsListFromDb } from "./sessionsListFromDb";
import { loadAgentUsageFromDb } from "./agentsUsageFromDb";
import { loadSkillUsageFromDb } from "./skillsUsageFromDb";
import { loadClaudeUsageStatsFromDb } from "./claudeUsageFromDb";
import { searchSessionsInDb } from "./sessionSearch";
import type {
  SessionSearchHit,
  SessionSearchScope,
} from "./sessionSearch";
import { loadSessionCostsInWindow } from "./sessionsInWindow";
import type { SessionCostRow } from "./sessionsInWindow";
import { demoMode } from "@/lib/demo/demoMode";
import { demoSessionsList, demoSessionDetail } from "@/lib/demo/sessions";
import { demoUsage, demoClaudeUsage, demoAgentUsage, demoSkillUsage } from "@/lib/demo/usage";
import type { UsageReport, AgentStats, SkillStats, UsageComparison } from "@/lib/usage/types";
import { getPeriodStart } from "@/lib/usage/periods";
import type { Period } from "@/lib/usage/constants";
import type { AggregatorPeriod } from "@/lib/usage/period";
import type {
  SessionDetail,
  SessionSummary,
  ClaudeUsageStats,
  InitStatus,
} from "@/lib/types";

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

// Schema-readiness state machine for `initDb()`. Replaces the prior
// `cached: { promise, failedAt }` cache.
//
// **Why a state machine?** The 30s-TTL failure cache that Wave 1.2
// introduced solved one bug (a real outage hammering initDb on every
// poll) but missed the inverse: a *transient* EBUSY (Windows file-
// lock-release lag during ingest write contention) would surface to
// every caller for the next 30s, downgrading the dashboard for no
// reason. The fix is to classify each failure and treat transient
// errors with a short internal retry loop — only after the retry
// budget is exhausted does the failure get cached.
//
// **States**:
//   - `idle` — no attempt yet, or last failure's TTL expired.
//   - `in-flight` — an attempt is running; concurrent callers share the
//     same promise.
//   - `success` — last attempt succeeded; cached until process exit.
//   - `transient-failed` — retry budget exhausted on transient errors.
//     Cached for 30s, then a fresh attempt is allowed.
//   - `permanent-failed` — the rebuild itself isn't recovering
//     (cumulative `quarantineRuns >= 2`). Sticky until process exit;
//     external operator action is the only path forward.
//
// **Classification** (`error.code`):
//   - `EBUSY/EPERM/ENOENT/ENOTEMPTY/SQLITE_BUSY/SQLITE_LOCKED` → transient.
//     Retried up to 3× with 100/300/900 ms backoff.
//   - Everything else (including unrecognized rejections) → fail fast,
//     cache as `transient-failed` for 30s. Retrying an unknown error
//     class without evidence it's lock contention is more likely to
//     hammer a sick DB than to recover.
//   - `result.quarantined !== null` is counted across the state
//     machine's lifetime; the 2nd cumulative observation flips
//     `permanent-failed`. Two rebuild-and-still-failing rounds is the
//     strongest signal we have that retrying further won't help.
//
// **Cache reset between tests**: existing tests use `vi.resetModules()`
// which gives a fresh module-scope `initState`. Same mechanism as the
// prior `cached` variable.

const RETRY_DELAYS_MS = [100, 300, 900] as const;
const TRANSIENT_TTL_MS = 30_000;

// Test-only override for retry backoff. Production code never sets this;
// tests inject `[0, 0, 0]` so the retry loop runs without scheduling
// any real setTimeouts. Using a module-level override (instead of an
// env var) keeps the production hot path read-only and trivially
// constant-folded.
let _retryDelaysOverride: readonly number[] | null = null;
/** @internal Test-only: shorten retry backoff for unit tests. */
export function __setRetryDelaysForTests(delays: readonly number[] | null): void {
  _retryDelaysOverride = delays;
}
/** @internal Test-only: force the state machine back to `idle`. */
export function __resetInitStateForTests(): void {
  initState = { kind: "idle", quarantineRuns: 0 };
}

const TRANSIENT_CODES = new Set([
  "EBUSY",
  "EPERM",
  "ENOENT",
  "ENOTEMPTY",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

type InitState =
  | { kind: "idle"; quarantineRuns: number }
  | {
      kind: "in-flight";
      promise: Promise<InitResult>;
      attempts: number;
      quarantineRuns: number;
    }
  | {
      kind: "success";
      result: InitResult;
      attempts: number;
      quarantineRuns: number;
    }
  | {
      kind: "transient-failed";
      failedAt: number;
      attempts: number;
      quarantineRuns: number;
      lastError: Error;
    }
  | {
      kind: "permanent-failed";
      failedAt: number;
      attempts: number;
      quarantineRuns: number;
      lastError: Error;
    };

let initState: InitState = { kind: "idle", quarantineRuns: 0 };

function getErrCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function isTransientError(err: Error | null): boolean {
  if (!err) return false;
  const code = getErrCode(err);
  if (code && TRANSIENT_CODES.has(code)) return true;
  // Some call paths wrap and lose the `.code` attribute — fall back to
  // a substring match on the message so a transient-by-name error still
  // gets retried. Keeps tests that throw `new Error("simulated EBUSY")`
  // (no `.code` field) classified as transient.
  const msg = err.message ?? "";
  for (const c of TRANSIENT_CODES) {
    if (msg.includes(c)) return true;
  }
  return false;
}

function synthFailureResult(error: Error): InitResult {
  return {
    available: false,
    appliedMigrations: [],
    schemaVersion: 0,
    quarantined: null,
    error,
  };
}

type InFlightState = Extract<InitState, { kind: "in-flight" }>;

async function runInitWithRetries(inFlight: InFlightState): Promise<InitResult> {
  let lastResult: InitResult | null = null;
  let lastError: Error | null = null;
  let permanent = false;

  const delays = _retryDelaysOverride ?? RETRY_DELAYS_MS;
  for (let attemptIdx = 0; attemptIdx <= delays.length; attemptIdx++) {
    if (attemptIdx > 0) {
      const delayMs = delays[attemptIdx - 1];
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // Mutate the in-flight state object so getInitStatus() can report
    // live attempt/quarantine counts during long retries — the in-flight
    // object IS the current `initState` until terminal commit below.
    inFlight.attempts = attemptIdx + 1;

    let result: InitResult | null = null;
    let thrown: Error | null = null;
    try {
      result = await initDb();
    } catch (err) {
      thrown = err as Error;
    }

    // Tally quarantines BEFORE classifying success/failure so success-
    // with-quarantine and failure-with-quarantine both observe the same
    // updated count. The 2-cumulative-quarantine permanent rule only
    // fires on the failure branch.
    if (result?.quarantined) inFlight.quarantineRuns += 1;

    if (result?.available) {
      initState = {
        kind: "success",
        result,
        attempts: inFlight.attempts,
        quarantineRuns: inFlight.quarantineRuns,
      };
      return result;
    }

    lastResult = result;
    lastError = thrown ?? result?.error ?? null;

    // 2nd cumulative quarantine + still-failing → rebuild itself isn't
    // recovering. Mark permanent. Process-exit only.
    if (inFlight.quarantineRuns >= 2) {
      permanent = true;
      break;
    }

    if (!isTransientError(lastError)) break;
    // transient — fall through to next retry iteration.
  }

  const finalError =
    lastError ?? new Error("initDb failed without surfacing an error");
  initState = {
    kind: permanent ? "permanent-failed" : "transient-failed",
    failedAt: Date.now(),
    attempts: inFlight.attempts,
    quarantineRuns: inFlight.quarantineRuns,
    lastError: finalError,
  };
  return lastResult ?? synthFailureResult(finalError);
}

/**
 * Drive the schema-readiness state machine forward and return the
 * resulting `InitResult`. Idempotent — `success` and within-TTL
 * `transient-failed` / `permanent-failed` states resolve immediately
 * without re-running `initDb()`.
 *
 * Distinct from `probeInitStatus()` in one important way: this function
 * **does not** check `dbModeRequested()`. Callers that need the schema
 * regardless of the `MINDER_USE_DB` flag (OTEL write-side ingest,
 * indexer worker startup) should use this. `probeInitStatus()`
 * intentionally short-circuits when DB mode isn't requested so
 * `/api/health` reports `idle` instead of actively probing — that's
 * correct for a passive health surface but wrong for callers that
 * write to the DB independent of the read-path flag.
 */
export function ensureSchemaReady(): Promise<InitResult> {
  switch (initState.kind) {
    case "success":
      return Promise.resolve(initState.result);
    case "in-flight":
      return initState.promise;
    case "permanent-failed":
      return Promise.resolve(synthFailureResult(initState.lastError));
    case "transient-failed":
      if (Date.now() - initState.failedAt < TRANSIENT_TTL_MS) {
        return Promise.resolve(synthFailureResult(initState.lastError));
      }
      // TTL expired — start a fresh attempt. Carry forward the
      // cumulative quarantine count so a transient-failed→retry that
      // tips into a 2nd quarantine still escalates to permanent.
      break;
    case "idle":
      break;
  }

  // Construct the in-flight state object first so `runInitWithRetries`
  // can mutate `attempts`/`quarantineRuns` on it as the loop progresses
  // — that way getInitStatus() reports live counts mid-flight rather
  // than a frozen `attempts: 0` snapshot.
  const inFlight: InFlightState = {
    kind: "in-flight",
    promise: undefined as unknown as Promise<InitResult>,
    attempts: 0,
    quarantineRuns: initState.quarantineRuns,
  };
  initState = inFlight;
  inFlight.promise = runInitWithRetries(inFlight);
  return inFlight.promise;
}

/**
 * Drive the schema-readiness state machine forward and return the
 * resulting status. Intended for external probes (`/api/health`) that
 * want an active health signal rather than a stale snapshot. Idempotent
 * — `success` and within-TTL `transient-failed` / `permanent-failed`
 * states return immediately without re-running `initDb()`.
 */
export async function probeInitStatus(): Promise<InitStatus> {
  if (!dbModeRequested()) return getInitStatus();
  await ensureSchemaReady();
  return getInitStatus();
}

export function getInitStatus(): InitStatus {
  const s = initState;
  switch (s.kind) {
    case "idle":
      return {
        state: "idle",
        attempts: 0,
        quarantineRuns: s.quarantineRuns,
        failedAt: null,
        lastError: null,
      };
    case "in-flight":
      return {
        state: "in-flight",
        attempts: s.attempts,
        quarantineRuns: s.quarantineRuns,
        failedAt: null,
        lastError: null,
      };
    case "success":
      return {
        state: "success",
        attempts: s.attempts,
        quarantineRuns: s.quarantineRuns,
        failedAt: null,
        lastError: null,
      };
    case "transient-failed":
    case "permanent-failed": {
      const code = getErrCode(s.lastError);
      return {
        state: s.kind,
        attempts: s.attempts,
        quarantineRuns: s.quarantineRuns,
        failedAt: s.failedAt,
        lastError: code
          ? { message: s.lastError.message, code }
          : { message: s.lastError.message },
      };
    }
  }
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
 *
 * Also used to gate `needsReconcileAfterV3` checks so its small
 * `SELECT FROM meta` can't escape as a raw `Error` if the meta
 * table is partially-migrated or the handle is stale (Codex P2
 * finding on PR #57). The function accepts both sync and async
 * loaders.
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
 * Run the v3-readiness gate (`needsReconcileAfterV3`) under
 * `callDbLoader` so a thrown SELECT (corrupt/partially-migrated
 * `meta` table, stale handle) surfaces as
 * `DbUnavailableError(reason: 'load-failed')` instead of a raw
 * `Error`. Keeps the typed-error contract uniform across the four
 * façade functions that gate on v3 readiness.
 */
async function checkV3Gate(scope: string, db: DbHandle): Promise<boolean> {
  return callDbLoader(`${scope}:v3-gate`, () => needsReconcileAfterV3(db));
}

/**
 * File-parse usage path. Used when `MINDER_USE_DB=0` (explicit
 * opt-out) or when the v3-readiness gate says the DB rows are mid-
 * migration.
 */
async function runFileUsage(
  period: AggregatorPeriod,
  project: string | undefined,
  source: string | undefined
): Promise<UsageResult> {
  // `getJsonlMaxMtime()` is captured AFTER report generation —
  // `parseAllSessions` warms the FileCache as a side effect, so a
  // pre-call read returns 0 on a cold process.
  const report = await generateUsageReport(period, project, source);
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
  period: AggregatorPeriod,
  project?: string,
  source?: string
): Promise<UsageResult> {
  if (await demoMode()) return demoUsage(period, project, Date.now());
  if (!dbModeRequested()) return runFileUsage(period, project, source);

  const db = await getReadyDb();
  if (await checkV3Gate("getUsage", db)) {
    logIntentionalFallthrough(
      "getUsage",
      "DB awaiting v3 reconcile (cost_usd / category_costs not yet populated)"
    );
    return runFileUsage(period, project, source);
  }
  const report = await callDbLoader("getUsage", () =>
    loadUsageReportFromSql(db, period, project, source)
  );
  if (!project) await augmentPortfolioYield(report);
  return { report, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
}

export interface UsageCompareResult {
  comparison: UsageComparison;
  meta: UsageBackendMeta;
}

/**
 * Period-over-period comparison (item 4a). SQL-only — there is no file-parse
 * compare path, so this degrades to a `comparable: false` result rather than
 * falling back:
 *
 * - `MINDER_USE_DB=0`: not comparable (comparison requires the SQL backend).
 * - DB mode + v3-catch-up: not comparable (cost columns not yet populated —
 *   running anyway would report misleading ~0 cost deltas).
 * - DB mode + healthy DB: SQL-backed `compareUsageFromSql`.
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 *
 * "all" likewise resolves to `comparable: false` (no prior window) — that
 * case is handled inside `compareUsageFromSql`.
 */
export async function getUsageCompare(
  period: string,
  project?: string,
  source?: string
): Promise<UsageCompareResult> {
  if (!dbModeRequested()) {
    return {
      comparison: buildNotComparable(
        period,
        "Period comparison requires the SQLite backend (MINDER_USE_DB is off)."
      ),
      meta: { backend: "file", maxMtimeMs: 0 },
    };
  }

  const db = await getReadyDb();
  if (await checkV3Gate("getUsageCompare", db)) {
    logIntentionalFallthrough(
      "getUsageCompare",
      "DB awaiting v3 reconcile (cost_usd not yet populated — comparison suppressed)"
    );
    return {
      comparison: buildNotComparable(
        period,
        "Period comparison is unavailable while the index finishes building."
      ),
      meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) },
    };
  }

  const comparison = await callDbLoader("getUsageCompare", () =>
    compareUsageFromSql(db, period, project, source)
  );
  return { comparison, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
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
export async function getSessionDetail(idOrSlug: string): Promise<SessionDetailResult> {
  if (await demoMode()) return demoSessionDetail(idOrSlug, Date.now());
  const result = await resolveSessionDetail(idOrSlug);
  // Enrich with Claude Code's own per-session metadata here in the façade —
  // above both the DB and file-parse paths AND shared by every consumer (the
  // HTTP route and the `get-session` MCP tool both call this). Best-effort:
  // a missing/malformed record is null.
  if (result.detail) {
    result.detail.sessionMeta = (await getSessionMeta(result.detail.sessionId)) ?? undefined;
  }
  return result;
}

async function resolveSessionDetail(idOrSlug: string): Promise<SessionDetailResult> {
  if (!dbModeRequested()) {
    const detail = await scanSessionDetail(idOrSlug);
    return { detail, meta: { backend: "file" } };
  }

  const db = await getReadyDb();

  // Disambiguate sessionId vs slug by shape. Hex-and-dash matches the
  // same gate `loadSessionDetailFromDb` and `scanSessionDetail` use
  // for sessionIds; anything containing letters past `f` is necessarily
  // a slug. Resolution runs BEFORE the v3-catch-up gate so
  // /sessions/<slug> URLs still resolve during the migration window
  // (the v3 gate falls back to file-parse but file-parse rejects
  // non-hex inputs; pre-resolving slug → canonical sessionId is what
  // bridges that).
  //
  // Edge case: a hex-only slug (e.g. `cafe-faded-deed`) would slip
  // through as a sessionId and miss the loader rather than resolving
  // via slug. Claude Code's slug dictionary uses words with letters
  // past `f`, so this isn't observed in practice; documented for
  // future generators.
  const looksLikeSessionId = /^[a-f0-9-]+$/i.test(idOrSlug);
  const sessionId = looksLikeSessionId ? idOrSlug : resolveSlugToSessionId(db, idOrSlug);
  const fallbackKey = sessionId ?? idOrSlug;

  if (await checkV3Gate("getSessionDetail", db)) {
    logIntentionalFallthrough(
      "getSessionDetail",
      "DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)"
    );
    const detail = await scanSessionDetail(fallbackKey);
    return { detail, meta: { backend: "file" } };
  }

  if (!sessionId) {
    const detail = await scanSessionDetail(idOrSlug);
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

/**
 * Look up the most-recent `session_id` for a given slug. Returns `null`
 * when the slug isn't indexed or doesn't pass the slug-shape gate.
 *
 * "Most-recent" matches the rule the SessionsBrowser uses to surface
 * the head of a continuation chain: `start_ts DESC` with `session_id`
 * tie-break. The continuation graph is already linked at reconcile
 * time; this is just the opposite direction (slug → leaf).
 *
 * Slug-shape gate: `/^[a-z0-9-]+$/`. Claude Code's generator emits
 * lowercase already, so mixed-case URLs simply won't match — chosen
 * over input-normalization to keep the SQL parameter exactly what the
 * caller sees, which makes debugging URL mismatches simpler.
 */
function resolveSlugToSessionId(db: DbHandle, slug: string): string | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const row = db
    .prepare(
      `SELECT session_id FROM sessions
        WHERE slug = ?
        ORDER BY start_ts DESC, session_id DESC
        LIMIT 1`
    )
    .get(slug) as { session_id: string } | undefined;
  return row?.session_id ?? null;
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
  if (await demoMode()) return demoSessionsList(Date.now());
  if (!dbModeRequested()) return runFileSessionsList();

  const db = await getReadyDb();
  if (await checkV3Gate("getSessionsList", db)) {
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
 *
 * In both backends, per-agent cost is computed via a parallel sidechain
 * file-parse (no schema migration required) and merged into the stats.
 */
export async function getAgentUsage(period: Period = "all"): Promise<AgentUsageResult> {
  if (await demoMode()) return demoAgentUsage(period, Date.now());
  const { computeAgentCostFromFiles } = await import("@/lib/usage/agentCost");

  // Per-agent cost is computed by walking sidechain JSONL turns and does
  // not currently honor a period filter. When the caller requests a
  // bounded window we deliberately skip the cost merge — the Cost tile
  // in ItemUsageBreakdown is already conditional on `costUsd > 0`, so it
  // simply hides rather than reporting all-time cost against bounded
  // invocations. All-time (period="all") keeps the existing behavior.
  async function withCost(stats: AgentStats[], meta: AgentUsageResult["meta"]): Promise<AgentUsageResult> {
    if (period !== "all") return { stats, meta };
    const costMap = await computeAgentCostFromFiles();
    return { stats: mergeAgentCost(stats, costMap), meta };
  }

  if (!dbModeRequested()) {
    const { stats, meta } = await runFileAgentUsage(period);
    return withCost(stats, meta);
  }

  const db = await getReadyDb();
  const sinceIso = getPeriodStart(period)?.toISOString();
  const stats = await callDbLoader("getAgentUsage", () => loadAgentUsageFromDb(db, sinceIso));
  // Cold-index fall-through ONLY applies to the all-time window. With
  // a bounded period (24h / 7d / 30d), an empty result is a legitimate
  // "no recent invocations" answer — falling back to file-parse would
  // pay the full JSONL walk cost per toggle click for that common
  // no-data case and would also flap the response backend between
  // `db` and `file`. See Codex P1 on PR #113.
  if (stats.length === 0 && period === "all") {
    logIntentionalFallthrough("getAgentUsage", "DB has zero Agent rows (indexer warming up?)");
    const { stats: fileStats, meta } = await runFileAgentUsage(period);
    return withCost(fileStats, meta);
  }
  return withCost(stats, { backend: "db" });
}

function mergeAgentCost(
  stats: AgentStats[],
  costMap: Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>
): AgentStats[] {
  if (costMap.size === 0) return stats;
  return stats.map((s) => {
    const cost = costMap.get(s.name) ?? costMap.get(s.name.toLowerCase());
    if (!cost || cost.costUsd === 0) return s;
    return { ...s, costUsd: cost.costUsd, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
  });
}

async function runFileAgentUsage(period: Period = "all"): Promise<AgentUsageResult> {
  // Lazy-import the file-parse pipeline to keep the DB happy-path off
  // the import graph for `parseAllSessions` / `groupAgentCalls` —
  // under normal operation we never load them.
  const { parseAllSessions } = await import("@/lib/usage/parser");
  const { groupAgentCalls } = await import("@/lib/usage/agentParser");
  const sessionMap = await parseAllSessions();
  const allTurns = Array.from(sessionMap.values()).flat();
  const sinceMs = getPeriodStart(period)?.getTime();
  const stats = groupAgentCalls(allTurns, sinceMs);
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
export async function getSkillUsage(period: Period = "all"): Promise<SkillUsageResult> {
  if (await demoMode()) return demoSkillUsage(period, Date.now());
  if (!dbModeRequested()) return runFileSkillUsage(period);

  const db = await getReadyDb();
  const sinceIso = getPeriodStart(period)?.toISOString();
  const stats = await callDbLoader("getSkillUsage", () => loadSkillUsageFromDb(db, sinceIso));
  // Same cold-index fall-through guard as `getAgentUsage` — empty rows
  // for a bounded period is a legitimate answer, not an indexer warmup
  // signal. See Codex P1 on PR #113.
  if (stats.length === 0 && period === "all") {
    logIntentionalFallthrough("getSkillUsage", "DB has zero Skill rows (indexer warming up?)");
    return runFileSkillUsage(period);
  }
  return { stats, meta: { backend: "db" } };
}

async function runFileSkillUsage(period: Period = "all"): Promise<SkillUsageResult> {
  const { parseAllSessions } = await import("@/lib/usage/parser");
  const { groupSkillCalls } = await import("@/lib/usage/skillParser");
  const sessionMap = await parseAllSessions();
  const allTurns = Array.from(sessionMap.values()).flat();
  const sinceMs = getPeriodStart(period)?.getTime();
  const stats = groupSkillCalls(allTurns, sinceMs);
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
  if (await demoMode()) return demoClaudeUsage(projectPaths, Date.now());
  if (!dbModeRequested()) return runFileClaudeUsage(projectPaths);

  const db = await getReadyDb();
  if (await checkV3Gate("getClaudeUsage", db)) {
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

export interface SessionSearchResult {
  hits: SessionSearchHit[];
  meta: { backend: "db" | "file" };
}

/**
 * Run a session search through the indexed FTS5 + sessions tables.
 *
 * - `MINDER_USE_DB=0`: returns `{ hits: [], meta: { backend: 'file' } }`
 *   — the file-parse path doesn't ship an FTS index, so the
 *   SessionsBrowser should fall back to client-side filtering of the
 *   cached `searchableText` column. Distinct from "DB available but
 *   no matches" so the UI can detect this case.
 * - DB mode + healthy DB: SQL-backed via `searchSessionsInDb`.
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 *
 * The v3-readiness gate is intentionally NOT applied — search hits
 * read `session_id` (and at most `slug` / `initial_prompt`) which
 * aren't gated by the cost-reconcile state. A user typing in the
 * search box during the catch-up window still gets results.
 */
export async function searchSessions(
  query: string,
  scope: SessionSearchScope = "both",
  limit?: number
): Promise<SessionSearchResult> {
  // Demo mode has no FTS index; return an empty (valid) result rather than
  // touch the DB. Prompt search over fixtures isn't needed for screenshots.
  if (await demoMode()) {
    return { hits: [], meta: { backend: "file" } };
  }
  if (!dbModeRequested()) {
    return { hits: [], meta: { backend: "file" } };
  }

  const db = await getReadyDb();
  // Direct call (no `callDbLoader` wrap): `SessionSearchError` carries
  // 4xx-class signals (`fts-parse` → 400) that the route maps to user-
  // facing errors. `callDbLoader` would convert it to
  // `DbUnavailableError(reason: 'load-failed')` and the route would
  // serve a 500 instead. Genuine SQLite failures bubble as raw
  // `SqliteError` and surface as 500s — the correct outcome for
  // "DB has a real problem."
  const hits = searchSessionsInDb(db, query, scope, limit);
  return { hits, meta: { backend: "db" } };
}

export type { SessionCostRow };

/**
 * Return sessions overlapping the given time window [startMs, endMs] for the
 * project slug. Used by the GSD planning tab to attribute cost to phases.
 *
 * Returns [] when DB mode is off or the DB is unavailable — the GSD route
 * treats an empty result as "cost unknown", not an error.
 */
export async function getSessionCostsInWindow(
  projectSlug: string,
  startMs: number,
  endMs: number,
): Promise<SessionCostRow[]> {
  if (!dbModeRequested()) return [];
  try {
    const db = await getReadyDb();
    return loadSessionCostsInWindow(db, projectSlug, startMs, endMs);
  } catch {
    return [];
  }
}

export type { SessionSearchHit, SessionSearchScope } from "./sessionSearch";
