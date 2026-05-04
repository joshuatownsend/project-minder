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
import { searchSessionsInDb } from "./sessionSearch";
import type {
  SessionSearchHit,
  SessionSearchScope,
} from "./sessionSearch";
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
// **Failure handling**: P2c established that we must not cache
// failures forever (a single transient EBUSY would silently downgrade
// every route to file-parse for the rest of the dev session). P2c
// cleared the cache on EVERY failure, which solved that bug but
// introduced a new one: a real outage (e.g. disk full, missing native
// binary) makes every subsequent call re-run `initDb()` end-to-end,
// hammering the DB layer on every dashboard poll.
//
// Wave 1.2 splits the difference with a 30s TTL on failed results:
// successful inits cache as before (until process exit), failed inits
// cache for up to 30s before the next caller is allowed to re-attempt.
// In-flight callers always share the same promise. The retry only
// kicks in after the failed promise has resolved AND the TTL has
// expired — concurrent failed callers within the TTL get the cached
// failure handed back without re-running initDb.
//
// Departure from plan: §5.1.2 specifies "schema corrupt → cache
// forever; init raced → retry up to 3× with 100ms backoff." The
// rename-retry half is already done by `renameWithRetry` (10× linear
// backoff on EBUSY/EPERM in `atomicWrite.ts`). The "cache forever"
// half conflicts with the same plan line that says "the cached
// failure now has a TTL; after 30s, next call retries." Picking the
// simpler design — a uniform 30s TTL — because (a) corruption can be
// repaired externally (operator deletes index.db) and we want to
// notice on the next retry, (b) categorizing failures to apply
// different cache policies is brittle (init can fail at multiple
// stages with similar symptoms), and (c) 30s is short enough that a
// genuinely permanent failure surfaces in any reasonable diagnostic
// window. Logged in CHANGELOG.
const FAILURE_TTL_MS = 30_000;
type CachedInit = {
  promise: Promise<InitResult>;
  /** Wall-clock when initDb() resolved with available=false (or rejected).
   *  null while in-flight or after a successful resolve. */
  failedAt: number | null;
};
let cached: CachedInit | null = null;

function ensureSchemaReady(): Promise<InitResult> {
  if (cached) {
    if (cached.failedAt === null) return cached.promise;
    if (Date.now() - cached.failedAt < FAILURE_TTL_MS) return cached.promise;
    // TTL expired — fall through to a fresh attempt.
    cached = null;
  }
  const promise = initDb();
  const slot: CachedInit = { promise, failedAt: null };
  cached = slot;
  promise
    .then((result) => {
      if (!result.available && cached === slot) {
        slot.failedAt = Date.now();
      }
    })
    .catch(() => {
      if (cached === slot) slot.failedAt = Date.now();
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
  if (await checkV3Gate("getUsage", db)) {
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
export async function getSessionDetail(idOrSlug: string): Promise<SessionDetailResult> {
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
  if (!dbModeRequested()) {
    return { hits: [], meta: { backend: "file" } };
  }

  const db = await getReadyDb();
  const hits = await callDbLoader("searchSessions", () =>
    searchSessionsInDb(db, query, scope, limit)
  );
  return { hits, meta: { backend: "db" } };
}

export type { SessionSearchHit, SessionSearchScope } from "./sessionSearch";
