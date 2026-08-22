import "server-only";
import { generateUsageReport, augmentPortfolioYield } from "@/lib/usage/aggregator";
import { getJsonlMaxMtime, canonicalizeDirName } from "@/lib/usage/parser";
import { scanAllSessions, scanSessionDetail, toSlug } from "@/lib/scanner/claudeConversations";
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
import { loadEngagementReportFromSql } from "./engagementFromDb";
import { getIndexBuildState } from "@/lib/db/indexerRuns";
import type { EngagementConfig, EngagementReport } from "@/lib/engagement/types";
import { loadSessionDetailFromDb } from "./sessionDetailFromDb";
import { loadSessionsListFromDb } from "./sessionsListFromDb";
import { loadAgentUsageFromDb } from "./agentsUsageFromDb";
import { loadSkillUsageFromDb } from "./skillsUsageFromDb";
import { loadClaudeUsageStatsFromDb } from "./claudeUsageFromDb";
import { searchSessionsInDb } from "./sessionSearch";
import type {
  SessionSearchHit,
  SessionSearchScope,
  SessionSearchFacets,
} from "./sessionSearch";
import { loadSessionCostsInWindow } from "./sessionsInWindow";
import type { SessionCostRow } from "./sessionsInWindow";
import type { FileEdit } from "@/lib/usage/fileActivity";
import type { PathMapping } from "@/lib/types";
import { demoMode } from "@/lib/demo/demoMode";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { mapLocalPath } from "@/lib/pathMapping";
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
/**
 * Why a DB-backed read could not be served.
 *
 * `index-building` is the odd one out and deliberately lives here rather than
 * in a parallel channel: the route already surfaces `reason` on its 503, so a
 * client can tell "still indexing" from "the database is off" with no new
 * plumbing. The others mean the backend is broken; this one means it is fine
 * and simply does not know the answer yet (#470).
 */
export type DbUnavailableReason =
  | "driver-missing"
  | "init-failed"
  | "connection-null"
  | "load-failed"
  | "index-building";

export class DbUnavailableError extends Error {
  readonly reason: DbUnavailableReason;
  constructor(
    reason: DbUnavailableReason,
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
// cases. These are not bugs — they're expected during migration
// windows, brand-new installs and first builds — but surfacing them
// once per process helps an operator spot a stuck reconcile or a cold
// indexer. Keyed per case so each kind gets logged once even if the
// others fire too.
//
// Six kinds now share this set, and three of them do NOT describe a
// fall-through: v3-catch-up, empty-index, and first-build all divert to
// file-parse, but the adapter/source/project decline keeps the SQL
// answer, and `getUsageCompare` suppresses its comparison instead. Read
// each message rather than assuming the shared set means a shared
// outcome — the messages were the whole finding. (Copilot, PR #474.)
const fallthroughLoggedFor = new Set<string>();

/** Emit `message` the first time `key` is seen in this process, then never again. */
function warnOnce(key: string, message: string): void {
  if (fallthroughLoggedFor.has(key)) return;
  fallthroughLoggedFor.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
}

function logIntentionalFallthrough(scope: string, reason: string): void {
  warnOnce(
    `${scope}:${reason}`,
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
 * Has the index not yet been read through even once?
 *
 * #472. `reconcileAllSessions` commits per file, so a first pass spends nearly
 * all of its duration with a row count that is non-zero and *rising*. Every
 * cross-corpus aggregate below therefore had a gate that could not see the
 * condition it was written for: "zero rows" catches an index that has not
 * started, never one that is part-way through. In that window a SQL answer is
 * computed correctly over a SUBSET and returned as `backend: "db"` with nothing
 * marking it partial — a session list, a usage total and an agent table that
 * quietly under-report until the pass lands.
 *
 * Single-row lookups (`getSessionDetail`) are exempt by construction: a session
 * is committed whole or not at all, so a hit is complete and a miss already
 * falls through.
 *
 * **Strictly additive — it does not replace the zero-rows checks.** With
 * `MINDER_INDEXER=0` nothing will ever record a pass, so `getIndexBuildState`
 * reports "ready" permanently (see `indexerRuns.ts`) and the zero-rows
 * fall-through is the only thing keeping those pages populated. Removing it
 * would empty the dashboard for exactly the operators who switched ingest off.
 *
 * Unlike `getEngagement`, which refuses with a 503, these fall back to
 * file-parse: they already have a working file path, and for a dashboard a
 * slower correct answer beats both a fast wrong one and an error page. The
 * cost of that is a full JSONL walk for the duration of the first pass —
 * measured, and bounded by the 2-minute route caches over `/api/usage`,
 * `/api/agents` and `/api/skills` (30 s for `/api/sessions`).
 */
/**
 * Does the file-parse path see the same corpus the SQL path does?
 *
 * It does not, whenever a non-Claude adapter is enabled. `discoverAllSessions`
 * — the thing that finds Codex and Gemini transcripts — is imported by
 * `db/ingest.ts` and by nothing else; every file-parse entry point walks
 * `<claude-home>/projects/**` and stops there. That is an architectural
 * boundary of the file backend, not a regression, and it long predates #472.
 *
 * It matters here because #472's gates exist to stop a subset being presented
 * as a total, and diverting an adapter-enabled install to file-parse would do
 * exactly that in a different direction: the SQL answer during the first pass
 * is a partial view of every source, while the file answer is a complete view
 * of Claude and a total absence of the rest. Dropping a source entirely is the
 * more distorting of the two, and it would be done in correctness's name.
 *
 * So where adapter sessions actually exist the gate declines to divert and the
 * pre-#472 behaviour stands. That leaves those users with the original defect,
 * which is worse than fixing it and better than pretending to. Closing it means
 * giving the file backend adapter discovery, which is a feature rather than a
 * review fix, and is tracked separately. (Codex P1, PR #474.)
 *
 * The test is whether adapter sessions are DISCOVERABLE, not whether an adapter
 * is enabled. Those differ, and by a lot: this repo's own config has enabled
 * `codex` for months against an index holding 6,600 Claude sessions and zero
 * Codex ones, so keying on the flag would have switched the whole of #472 off
 * for the machine it was written on, to protect a corpus that does not exist.
 * A predicate that is cheap and wrong is not cheaper than the walk.
 *
 * Ordered so the walk is skipped in the common case: a claude-only config
 * answers from the config alone, and the discovery below runs only while the
 * index is building AND an adapter is enabled. A discovery that throws counts
 * as "does not cover" — if we cannot tell what is out there, we must not claim
 * to have read all of it.
 */
async function fileParseCoversCorpus(source?: string, project?: string): Promise<boolean> {
  // **The asymmetry that governs every narrowing below.** A false "not covered"
  // costs nothing new: the SQL answer is what shipped before #472 either way. A
  // false "covered" reintroduces the original defect and drops a whole source in
  // correctness's name. So a filter is honoured here only when the mapping is
  // exact BY CONSTRUCTION — the same derivation the ingest path uses — never
  // when it merely looks equivalent.
  //
  // `source` qualifies by string equality. A request already scoped to Claude is
  // covered whatever else exists, since `generateUsageReport` applies the same
  // filter and the adapter corpus is not part of the answer being asked for. One
  // scoped to a non-Claude source is covered by nothing — file-parse would
  // return empty, which is worse than a partial SQL result — so it never
  // diverts. (Codex P1, PR #474.)
  //
  // `project` qualifies because `toSlug(canonicalizeDirName(projectDirName))` is
  // literally how ingest derives `sessions.project_slug`, and
  // `loadUsageReportFromSql` filters on that column — so the predicate and the
  // SQL it is standing in for agree by construction rather than by coincidence.
  // Codex adapter files in OTHER projects are therefore not part of a
  // project-scoped answer and must not suppress the fallback. (Codex P1.)
  //
  // Two filters are deliberately NOT honoured, both for the same reason.
  // `home`: whether an adapter session can carry one, and what a home filter
  // means for it, is unsettled in `loadUsageReportFromSql`. And
  // `getClaudeUsage`'s project scope, which Codex named alongside this one: it
  // is keyed on `encodePath`-encoded Claude paths, while an adapter's
  // `projectDirName` is whatever that adapter chose, so matching them is a
  // resemblance rather than a derivation. Both stay corpus-global, which is the
  // conservative direction.
  if (source) return source === "claude";
  const cfg = await readConfig();
  if ((cfg.enabledAdapters ?? ["claude"]).every((id) => id === "claude")) return true;
  try {
    const { discoverAllSessions } = await import("@/lib/adapters");
    // Non-Claude adapters ONLY. `discoverAllSessions(cfg)` runs every enabled
    // adapter's `discover()`, and Claude's walks every home's projects tree —
    // so passing the config unfiltered would sweep the whole Claude corpus to
    // answer a question exclusively about the other adapters, and then sweep it
    // again in the file-parse fallback this is gating into. (Copilot, PR #474.)
    const found = await discoverAllSessions({
      ...cfg,
      enabledAdapters: (cfg.enabledAdapters ?? []).filter((id) => id !== "claude"),
    });
    if (!project) return found.length === 0;
    return !found.some(
      (f) => toSlug(canonicalizeDirName(f.projectDirName)) === project
    );
  } catch {
    return false;
  }
}

/**
 * The build-state gate for the five loaders that answer from a corpus.
 *
 * **Covers the first build, not a re-derivation.** `getIndexBuildState` is a
 * lifetime latch, so a `DERIVED_VERSION` rebuild — which rewrites rows one file
 * at a time and can therefore mix old and new derived values across an
 * aggregate for the length of the rebuild — reads as "ready" here. That is a
 * real defect and these five loaders do read derived columns, which is exactly
 * the case `getIndexBuildState`'s own docstring warns off this predicate. It is
 * also unchanged by #472: before it, `getUsage` had no gate at all and the rest
 * had zero-rows gates, so a rebuild served mixed rows then too. Fixing it needs
 * either an indexed staleness probe (an unindexed one measures 24 ms per
 * request on a 6,600-session index) or a writer for the `'rebuild'` run kind
 * that has never been written — a feature either way, tracked as #478 rather
 * than folded into a review round. (Codex P1, PR #474.)
 *
 * Composed rather than folded into `isIndexBuilding`, because
 * `getUsageCompare` must keep gating unconditionally: it degrades to
 * "not comparable" rather than falling back, so it needs no corpus and the
 * adapter question does not arise. Putting the check in the shared predicate
 * would silently return adapter users to comparing two DB subsets — the exact
 * defect, reintroduced by the fix for the defect.
 */
async function checkBuildStateFallback(
  scope: string,
  db: DbHandle,
  source?: string,
  project?: string
): Promise<boolean> {
  if (!isIndexBuilding(db)) return false;
  if (await fileParseCoversCorpus(source, project)) {
    logIntentionalFallthrough(scope, BUILDING_REASON);
    return true;
  }
  warnOnce(
    `${scope}:adapters-enabled`,
    `[data] ${scope}: index still building, but a non-Claude adapter is enabled and ` +
      "file-parse cannot see adapter sessions — serving the SQL answer rather than " +
      "trading a partial view of every source for a complete view of one."
  );
  return false;
}

function isIndexBuilding(db: DbHandle): boolean {
  // `getIndexBuildState` swallows its own read errors and fails open to
  // "ready", so unlike `checkV3Gate` this needs no `callDbLoader` wrapper —
  // a readiness check must never convert a schema fault into an outage.
  return getIndexBuildState(db) === "building";
}

/**
 * Deliberately silent, and its callers are not.
 *
 * This used to log "fell back to file-parse" itself, which put the message
 * before the decision: `checkBuildStateFallback` can go on to decline the
 * diversion when adapter sessions exist, and `getUsageCompare` never diverts at
 * all — so an operator reading the log during exactly the window this feature
 * exists for was told a fallback had happened in two cases where it had not.
 * A diagnostic that reports the branch it was hoping for rather than the branch
 * taken is worse than none. Each caller now logs its own outcome. (Copilot,
 * PR #474.)
 */
const BUILDING_REASON =
  "index still building (no full pass recorded yet) — a SQL answer here would be a subset of the corpus presented as the whole of it";

/**
 * File-parse usage path. Used when `MINDER_USE_DB=0` (explicit
 * opt-out) or when the v3-readiness gate says the DB rows are mid-
 * migration.
 */
async function runFileUsage(
  period: AggregatorPeriod,
  project: string | undefined,
  source: string | undefined,
  home: string | undefined
): Promise<UsageResult> {
  // `getJsonlMaxMtime()` is captured AFTER report generation —
  // `parseAllSessions` warms the FileCache as a side effect, so a
  // pre-call read returns 0 on a cold process.
  const report = await generateUsageReport(period, project, source, home);
  return { report, meta: { backend: "file", maxMtimeMs: getJsonlMaxMtime() } };
}

/**
 * Run the usage report through whichever backend is enabled.
 *
 * - `MINDER_USE_DB=0`: file-parse, returns immediately.
 * - DB mode + healthy DB + reconcile complete: SQL-backed.
 * - DB mode + v3-catch-up window: file-parse fallback (correctness).
 * - DB mode + first reconcile still running: file-parse fallback (#472 —
 *   a SQL total over a partly-ingested corpus is simply a wrong number).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getUsage(
  period: AggregatorPeriod,
  project?: string,
  source?: string,
  home?: string
): Promise<UsageResult> {
  // Demo fixtures model a single synthetic home — the discriminator is
  // meaningless there, so it's ignored rather than threaded through.
  if (await demoMode()) return demoUsage(period, project, Date.now(), source);
  if (!dbModeRequested()) return runFileUsage(period, project, source, home);

  const db = await getReadyDb();
  if (await checkV3Gate("getUsage", db)) {
    logIntentionalFallthrough(
      "getUsage",
      "DB awaiting v3 reconcile (cost_usd / category_costs not yet populated)"
    );
    return runFileUsage(period, project, source, home);
  }
  // #472. This one had no cold-index gate at ALL — not even the zero-rows
  // check its neighbours carry — so a first-pass read returned a partial
  // token/cost total as `backend: "db"` with nothing to distinguish it from a
  // complete one. The other sites under-reported in a window; this reported a
  // number that was simply wrong.
  if (await checkBuildStateFallback("getUsage", db, source, project)) {
    return runFileUsage(period, project, source, home);
  }
  const report = await callDbLoader("getUsage", () =>
    loadUsageReportFromSql(db, period, project, source, home)
  );
  if (!project) await augmentPortfolioYield(report);
  return { report, meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) } };
}

export interface EngagementResult {
  report: EngagementReport;
  meta: UsageBackendMeta;
}

/**
 * Human-engagement (timecard) report.
 *
 * **SQL-only, and it says so rather than degrading.** Unlike `getUsage`, there
 * is no file-parse fallback: the report needs every turn in the period sorted
 * on one timeline to reconstruct attendance, which over the JSONL corpus means
 * parsing millions of lines per request. With `MINDER_USE_DB=0` this throws
 * `DbUnavailableError` so the route can return an explicit 503 — a silent
 * empty report would read as "you did no billable work".
 */
export async function getEngagement(
  period: string,
  timeZone: string,
  config: EngagementConfig,
  project?: string,
  home?: string
): Promise<EngagementResult> {
  if (!dbModeRequested()) {
    throw new DbUnavailableError(
      "driver-missing",
      "The engagement report requires the SQLite index (MINDER_USE_DB is off)."
    );
  }
  const db = await getReadyDb();
  // #470: refuse rather than under-report. Until the index has been read
  // through once, a SQL answer here is a SUBSET of the user's work presented as
  // the whole of it — and this is the billable-hours figure, where a low number
  // that looks true is worse than an error. `getUsageCompare` below already
  // takes this shape for its own (different) readiness condition.
  //
  // Latched on "first full pass completed", not "a pass is running": the 30 s
  // sweep re-runs the same reconcile forever, so the live reading would flap
  // the report in and out of availability every half minute. See
  // `getIndexBuildState` for why a DERIVED_VERSION rebuild correctly does not
  // gate this consumer: it reads only raw columns, which the five loaders in
  // `checkBuildStateFallback` do NOT.
  if (getIndexBuildState(db) === "building") {
    throw new DbUnavailableError(
      "index-building",
      "The engagement report is unavailable while the index finishes building — " +
        "the figures would be a subset of your work, not a total."
    );
  }
  const report = await callDbLoader("getEngagement", () =>
    loadEngagementReportFromSql(db, { period, timeZone, config, project, home })
  );
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
 * - DB mode + first reconcile still running: not comparable (#472 — both
 *   windows would be subsets, making the delta between them arbitrary).
 * - DB mode + healthy DB: SQL-backed `compareUsageFromSql`.
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 *
 * "all" likewise resolves to `comparable: false` (no prior window) — that
 * case is handled inside `compareUsageFromSql`.
 */
export async function getUsageCompare(
  period: string,
  project?: string,
  source?: string,
  home?: string
): Promise<UsageCompareResult> {
  if (await demoMode()) {
    // Demo mode doesn't model two comparable historical windows; return a
    // not-comparable sentinel so the Compare toggle shows a message instead of
    // hitting SQLite (which would 500 on a machine with no index).
    return {
      comparison: buildNotComparable(period, "Period comparison isn't available in demo mode."),
      meta: { backend: "file", maxMtimeMs: 0 },
    };
  }
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

  // #472. There is no file-parse compare path, so this degrades rather than
  // falls back — the same shape the v3 gate above already uses. Comparing two
  // windows of a half-built index is worse than comparing nothing: both sides
  // are subsets, and the *ratio* between them is arbitrary, so the delta would
  // read as a real week-over-week swing.
  if (isIndexBuilding(db)) {
    warnOnce(
      `getUsageCompare:${BUILDING_REASON}`,
      `[data] getUsageCompare: comparison suppressed (${BUILDING_REASON}). ` +
        "This one degrades to a not-comparable result rather than falling back — " +
        "there is no file-parse compare path, and two subsets make an arbitrary delta."
    );
    return {
      comparison: buildNotComparable(
        period,
        "Period comparison is unavailable until the index has been read through once."
      ),
      meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) },
    };
  }
  const comparison = await callDbLoader("getUsageCompare", () =>
    compareUsageFromSql(db, period, project, source, home)
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
 * - DB mode + first reconcile still running: file-parse (#472 — the list
 *   would otherwise show whichever subset had been ingested so far).
 * - DB mode + empty index: file-parse (UX — brand-new install
 *   still surfaces sessions while the indexer warms up, and the only
 *   fallback left when `MINDER_INDEXER=0` makes "building" unreachable).
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
  if (await checkBuildStateFallback("getSessionsList", db)) {
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
 * - DB mode + first reconcile still running: file-parse fallback, for
 *   every period (#472).
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
  // Before the query, and — unlike the zero-rows guard below — for EVERY
  // period. The Codex P1 that made that guard all-time-only reasoned that an
  // empty bounded window is a legitimate "no recent invocations" answer. True,
  // and untouched. But an index that has never been read through cannot answer
  // a 7-day question either; the two conditions are orthogonal.
  if (await checkBuildStateFallback("getAgentUsage", db)) {
    const { stats: fileStats, meta } = await runFileAgentUsage(period);
    return withCost(fileStats, meta);
  }
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
 * - DB mode + healthy DB + reconcile complete + non-empty rows: SQL-backed.
 * - DB mode + v3-catch-up: file-parse (correctness — A4 made this a
 *   `cost_usd` reader; see the gate below).
 * - DB mode + first reconcile still running: file-parse fallback, for
 *   every period (#472).
 * - DB mode + zero rows: file-parse fallback (UX).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getSkillUsage(period: Period = "all"): Promise<SkillUsageResult> {
  if (await demoMode()) return demoSkillUsage(period, Date.now());
  if (!dbModeRequested()) return runFileSkillUsage(period);

  const db = await getReadyDb();
  // This docstring used to read "No v3 gate — pure tool_uses aggregation, no
  // cost columns." That was accurate until A4 added the attribution query,
  // which sums `turns.cost_usd`. During v3 catch-up `cost_usd` is 0 on every
  // pre-existing row while `attribution_skill` is already populated, so the
  // loader would return rows that are non-empty (no empty-index fallback) and
  // priced at zero — the catalog would show every skill's spend as $0 and look
  // authoritative doing it.
  if (await checkV3Gate("getSkillUsage", db)) {
    logIntentionalFallthrough(
      "getSkillUsage",
      "DB awaiting v3 reconcile (attributed cost_usd not yet populated)"
    );
    return runFileSkillUsage(period);
  }
  // Every period, for the same reason as `getAgentUsage` above.
  if (await checkBuildStateFallback("getSkillUsage", db)) {
    return runFileSkillUsage(period);
  }
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
  const { groupSkillCalls, attachSkillAttribution } = await import("@/lib/usage/skillParser");
  const { loadPricing, computeTurnCostSync } = await import("@/lib/usage/costCalculator");
  // Sidechain turns carry attribution too — a skill that delegates still caused
  // the delegate's spend — so this asks for them explicitly rather than taking
  // the default primary-only view.
  const sessionMap = await parseAllSessions({ includeSidechains: true });
  const allTurns = Array.from(sessionMap.values()).flat();
  // Invocation counts stay PRIMARY-ONLY. They're tool-derived, and the DB
  // ingest writes no `tool_uses` for sidechain turns, so counting a subagent's
  // Skill dispatch here would make the catalog's invocation number depend on
  // which backend served the request — and would silently change a
  // pre-existing figure that has nothing to do with attribution.
  const primaryTurns = allTurns.filter((t) => t.isSidechain !== true);
  const sinceMs = getPeriodStart(period)?.getTime();
  const stats = groupSkillCalls(primaryTurns, sinceMs);
  // Pricing is resolved once up front so the per-turn cost lookup can be
  // synchronous — awaiting inside the accumulation loop would serialize tens
  // of thousands of turns for no benefit.
  await loadPricing();
  attachSkillAttribution(stats, allTurns, computeTurnCostSync, sinceMs);
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
 * - DB mode + first reconcile still running: file-parse fallback (#472).
 * - DB mode + zero conversations for the filter set: file-parse (UX).
 * - DB mode + DB unhealthy: throws `DbUnavailableError` → 500.
 */
export async function getClaudeUsage(projectPaths: string[]): Promise<ClaudeUsageResult> {
  if (await demoMode()) return demoClaudeUsage(projectPaths, Date.now());
  // Expand each path with its mapped (foreign) form so UNC-scanned WSL
  // projects match their Linux-encoded session dirs in BOTH backends — the
  // DB loader filters by encodePath(path), and the file fallback matches
  // encoded dir names across homes.
  const usageCfg = await readConfig();
  const usageMappings = usageCfg.pathMappings ?? [];
  const expandedPaths = [
    ...new Set(
      projectPaths.flatMap((p) => {
        const mapped = mapLocalPath(p, usageMappings);
        return mapped !== p ? [p, mapped] : [p];
      })
    ),
  ];
  if (!dbModeRequested()) return runFileClaudeUsage(expandedPaths);

  const db = await getReadyDb();
  if (await checkV3Gate("getClaudeUsage", db)) {
    logIntentionalFallthrough(
      "getClaudeUsage",
      "DB awaiting v3 reconcile (cost_usd / one-shot counts not yet populated)"
    );
    return runFileClaudeUsage(expandedPaths);
  }
  if (await checkBuildStateFallback("getClaudeUsage", db)) {
    return runFileClaudeUsage(expandedPaths);
  }
  const stats = await callDbLoader("getClaudeUsage", () =>
    loadClaudeUsageStatsFromDb(db, expandedPaths)
  );
  if (stats.conversationCount === 0) {
    logIntentionalFallthrough(
      "getClaudeUsage",
      "DB has zero conversations for the filter set (indexer warming up?)"
    );
    return runFileClaudeUsage(expandedPaths);
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
/**
 * Write-class file edits for one project, from the index when it is usable.
 *
 * Returns `null` — not `[]` — when the SQL path is unavailable (demo mode,
 * `MINDER_USE_DB=0`, or a DB that will not open). The distinction is
 * load-bearing: `[]` is a real answer meaning "this project has edited no
 * files", and a caller that conflated the two would render an empty Hot Files
 * panel for a healthy project whose index merely failed to open. `null` tells
 * the route to fall back to the JSONL parse instead.
 *
 * Backend selection lives here rather than in the two routes so they cannot
 * drift apart in when they use which path (#439).
 */
export async function loadProjectFileEdits(opts: {
  slug: string;
  projectPath: string;
  mappings?: PathMapping[];
  homes?: string[];
}): Promise<FileEdit[] | null> {
  if (await demoMode()) return null;
  if (!dbModeRequested()) return null;
  try {
    const db = await getReadyDb();

    // A usable DB is not a CURRENT one. During the first reconcile, or in the
    // ingest-lag window after a session is written, `getReadyDb()` succeeds
    // while the index still knows nothing about the newest transcripts — and
    // both callers cache whatever they get for five minutes, so a project with
    // real edits on disk would show an empty Hot Files panel for minutes at a
    // time (Codex, PR #454).
    //
    // The freshness test lives in the loader because it has to be PER PROJECT
    // and filesystem-backed. The obvious global check —
    // `getDbMaxMtimeMs(db) < getJsonlMaxMtime()` — is worse than useless here:
    // `getJsonlMaxMtime()` reads the usage parser's in-memory FileCache
    // (`parser.ts`, and see the note on `runFileSessionsList`), so on a cold
    // server it returns 0 and the gate silently passes in exactly the
    // cold-start window it was meant to catch.
    //
    // A `null` here means "index not current for this project", which the
    // caller treats the same as "DB unavailable": fall back to the file parse.
    const { loadProjectFileEditsFromDb } = await import("./fileActivityFromDb");
    return loadProjectFileEditsFromDb(db, opts);
  } catch {
    // Never throw: these routes have a working file-parse path, so a DB
    // problem should cost latency, not the panel.
    return null;
  }
}

export async function searchSessions(
  query: string,
  scope: SessionSearchScope = "both",
  limit?: number,
  /**
   * Row-level facets pushed into every retriever's SQL so the `LIMIT`
   * applies to the faceted population (#425). Omitted = unfiltered.
   */
  facets?: SessionSearchFacets
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
  // Semantic retrieval is resolved HERE rather than inside
  // `searchSessionsInDb`, which is synchronous by design; embedding a query
  // is async ONNX inference. Flag-gated and default-off (the first run
  // downloads ~80 MB), and every failure inside returns an empty list, so
  // this reduces to exactly the previous behaviour when it isn't available.
  let semanticKeys: string[] = [];
  if (scope !== "titles") {
    try {
      const config = await readConfig();
      if (getFlag(config.featureFlags, "semanticSearch", false)) {
        const { semanticSessionKeys } = await import("@/lib/embeddings/search");
        semanticKeys = await semanticSessionKeys(db, query, (limit ?? 20) * 3);
      }
    } catch {
      // Search must never fail because the optional retriever did.
    }
  }

  const hits = searchSessionsInDb(db, query, scope, limit, semanticKeys, facets);
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

export type { SessionSearchHit, SessionSearchScope, SessionSearchFacets } from "./sessionSearch";
