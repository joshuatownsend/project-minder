import { toPrLinkSource } from "@/lib/types/session";
import "server-only";
import type DatabaseT from "better-sqlite3";
import {
  projectSessionSummary,
} from "@/lib/sessions/summaryProjection";
import { prepCached } from "@/lib/db/connection";
import type { SessionSummary, SessionStatus, PrLink, TicketLink } from "@/lib/types";
import { rollUpTreeDelegation, type DelegationTreeSource } from "@/lib/usage/delegationTree";
import { parseSubagentParentSessionId } from "@/lib/sessions/subagentTranscriptPath";
import { clipSummaryPrompts } from "./sessionsListPayload";

// SQL-backed list loader for `/api/sessions` and `/api/sessions/activity`.
// Mirrors `scanAllSessions` (in `src/lib/scanner/claudeConversations.ts`)
// but assembles every `SessionSummary` from indexed rows rather than
// re-parsing every JSONL file in `~/.claude/projects/`. Five queries:
// one for the session headers, one each for the per-session tool / skill
// / model breakdown maps, and (implicitly) `subagentCount` falls out of
// the tool-count query as `toolUsage['Agent']`. All five fan out by
// `session_id` and are stitched in JS, so the indexer's existing
// `(session_id, ...)` PK prefixes do all the heavy lifting.
//
// **Documented divergences from the file-parse path** — same posture as
// `loadSessionDetailFromDb`'s header comment. Closing any of these would
// require schema or ingest changes; documented here so any callsite
// difference shows up in code review rather than user behavior.
//
// 1. `recaps`: `undefined` (was: parsed from `entry.type === "system"
//    && subtype === "away_summary"`). Ingest skips non-user/non-assistant
//    entries.
// 2. `searchableText`: `undefined` (#700). The list used to carry up to
//    4,000 characters per session for the Sessions page to filter on
//    locally, 13 MB of a 34 MB response. Content search goes through
//    `/api/sessions/search` (FTS5 over the full turn text) instead.
// 3. `status`: **`needs_attention` restored as of P2c.** Ingest now
//    walks each parsed session inline with the same pending-pairs
//    algorithm as `inferSessionStatus` (`src/lib/scanner/sessionStatus.ts`)
//    and stores a snapshot in `sessions.status` — `'waiting'` when
//    the last assistant turn had unresolved tool_uses, `'inactive'`
//    otherwise. The loader reads that snapshot, then time-gates
//    `'waiting'` against `file_mtime_ms` to derive
//    `working / needs_attention / idle` — `working` if mtime fresh
//    (< 90 s), `needs_attention` if in [90 s, 10 min] window,
//    `idle` if older. Sessions written before P2c (or on the
//    legacy file-parse path) have `status = NULL` and fall back to
//    the original 2-min mtime heuristic until the next full
//    reconcile populates the snapshot. **Staleness window**:
//    `appendSessionTail` only refreshes status when the tail itself
//    contains an assistant turn; user-only tails (e.g., a tool
//    completion arriving alone) leave the prior `'waiting'`
//    snapshot in place. The dashboard's time-gating hides this for
//    abandoned sessions (they age out to `idle` after 10 min) but
//    a session that resolved its pendings and went idle within the
//    same dev-server lifetime keeps showing as `working` /
//    `needs_attention` until next full reconcile. Acceptable for
//    the typical ~150-session corpus; tracked for follow-up if it
//    becomes noisy.
// 4. **Sidechain entries skipped at ingest** (same as detail divergence
//    #7): token sums, `messageCount`, `userMessageCount`,
//    `assistantMessageCount`, `toolUsage`, `skillsUsed`, `modelsUsed`,
//    `subagentCount`, `costEstimate` for sessions that dispatched
//    subagents will be lower under DB.
// 5. `oneShotRate`: derived from `sessions.verified_task_count` /
//    `one_shot_task_count` stamped at ingest, vs file-parse running
//    `detectOneShot` over `lightTurns` afresh. Pricing/classifier-version
//    drift between writer and reader is invisible until reconcile (same
//    posture as `loadUsageReportFromSql`).
// 6. `costEstimate`: pre-computed `sessions.cost_usd` (per-turn
//    `applyPricing` at ingest) rather than file-parse's per-model
//    `loadPricing`+`getModelPricing` post-pass. Pricing-version drift
//    is gated by the existing `needsReconcileAfterV3` check that the
//    façade applies to the usage and detail paths; the list path could
//    in principle skip the gate (sort key is `end_ts`, not cost) but
//    the per-session `costEstimate` shown in cards would still drift,
//    so the façade applies the same gate uniformly.
// 7. `isActive`: same 2-min mtime heuristic in both backends — matches.
// 8. **`startTime` / `endTime` derived from non-sidechain turns only**:
//    DB ingest stamps `sessions.start_ts` / `end_ts` from `turns.ts`,
//    and `turns` skips sidechain / meta / non-(user|assistant) entries via
//    three separate guards in `readJsonlSession`:
//    `entry.isSidechain && !isDelegatedAgentTranscript` drops sidechains,
//    `entry.isMeta || !entry.timestamp` drops meta, and
//    `type !== "assistant" && type !== "user"` drops the rest. Note the
//    exception, which makes the first narrower than it reads: a DELEGATED
//    subagent transcript fails that condition, so its entries fall through
//    and DO stamp `startTs`/`endTs`. File-parse's `scanSessionFileRaw`
//    walks every JSONL entry's `timestamp`.
//    For sessions with sidechain or system entries before the first
//    user turn or after the last assistant turn, the DB path's
//    `startTime` / `endTime` (and therefore `durationMs`) can fall
//    inside the file-parse window — the file-parse window strictly
//    contains the DB window, never the reverse.
// 9. `toolUsage` / `subagentCount`: the DB drops a **re-logged** tool
//    block, file-parse does not. Claude Code writes one JSONL line per
//    content block, all sharing a `message.id`; ingest unions those
//    blocks and dedupes on `tool_use_id`, while `claudeConversations.ts`
//    has no dedupe at all and counts a re-log twice. So file-parse now
//    OVER-counts by the re-log rate — 22 blocks in 5,591 on the
//    reference corpus, ~0.4%.
//
//    This entry used to point the other way and by 12x. Ingest `continue`d
//    on the repeat id and threw the block away with it, storing 6 `Agent`
//    calls for a session that made 72 (#426). Direction is worth stating
//    plainly: the residual is file-parse counting a rare duplicate, not
//    the DB missing most of the data.
// 10. `treeDelegation` (#395): **DB-only, and only once re-derived.** The
//    tree roll-up needs `sidechain_tool_uses`, which no file-parse pass
//    produces —
//    `claudeConversations.ts` walks top-level transcripts and never opens
//    `<session>/subagents/*.jsonl`. So the file backend leaves the field
//    undefined and the delegation badge does not render there.
//
//    That is a deliberate downgrade, not an oversight. The badge asserts a
//    session "may have been silently truncated" by a cap; the only number
//    file-parse can offer is the root-only count that #395 was filed about,
//    which under-reports by the whole nested tree. A missing badge is the
//    honest form of "not measured here" — the same rule `delegationLimits.ts`
//    already applies to `concurrent` and `depth`.
//
//    The DB backend is subject to the same rule over time rather than over
//    backends: until a session and every linked child reach
//    `TREE_DELEGATION_MIN_DERIVED_VERSION`, the field stays undefined.

interface SessionRow {
  session_id: string;
  project_slug: string | null;
  project_dir_name: string;
  file_path: string;
  file_mtime_ms: number;
  start_ts: string | null;
  end_ts: string | null;
  /**
   * Stored snapshot from `inferSessionStatus`'s pending-pairs walk at
   * last full-reconcile (or last assistant-bearing tail-append). One of
   * `'waiting'` (had unresolved pendings) | `'inactive'` (no pendings,
   * idle) | NULL (existing row not yet re-ingested with status). The
   * loader time-gates `'waiting'` against `file_mtime_ms` to derive
   * `working / needs_attention / idle` at READ time, so the snapshot
   * carries only the pending-bit, not the freshness classification.
   */
  status: string | null;
  turn_count: number;
  user_turn_count: number;
  assistant_turn_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  cache_hit_ratio: number | null;
  max_context_fill: number | null;
  has_compaction_loop: number;
  has_tool_failure_streak: number;
  verified_task_count: number;
  one_shot_task_count: number;
  git_branch: string | null;
  initial_prompt: string | null;
  last_prompt: string | null;
  slug: string | null;
  continued_from_session_id: string | null;
  has_thinking: number;
  cli_version: string | null;
  has_resume_anomaly: number;
  compact_boundary_count: number;
  generated_title: string | null;
  starred_at: string | null;
  distilled_at: string | null;
  distilled_text: string | null;
  work_mode_exploration_pct: number | null;
  work_mode_building_pct: number | null;
  work_mode_testing_pct: number | null;
  work_mode_other_pct: number | null;
  source: string | null;
  // A1 (schema v20). Null on any transcript predating the field.
  session_kind: string | null;
  ai_title: string | null;
  entrypoint: string | null;
  /** Gates the #395 tree roll-up — see `rollUpTreeDelegation`. */
  derived_version: number;
}

interface ToolCountRow {
  session_id: string;
  tool_name: string;
  n: number;
}

interface EffortCountRow {
  session_id: string;
  effort: string;
  n: number;
}

interface SkillCountRow {
  session_id: string;
  skill_name: string;
  n: number;
}

interface ModelRow {
  session_id: string;
  model: string;
}

/**
 * The last list built, kept until the index changes (#689). Building it runs
 * eight whole-table queries and assembles every session, about 4-5 s on a
 * 3 GB index, all synchronous on the main thread; the `/api/sessions` slot
 * asked for it every 30 s. On `globalThis` because the production build
 * bundles this module more than once.
 *
 * Keyed by the connection plus `PRAGMA data_version`, which moves when
 * another connection (the ingest worker) commits, and `total_changes()`, which
 * moves when this one writes (starring, titles, distills).
 */
interface SessionsListMemo {
  db: DatabaseT.Database;
  key: string;
  sessions: SessionSummary[];
  /** Per-session inputs of the two clock-derived fields, by index. */
  clock: Array<{ storedStatus: string | null; fileMtimeMs: number }>;
}
const memoHolder = globalThis as unknown as { __minderSessionsListMemo?: SessionsListMemo };

function indexChangeKey(db: DatabaseT.Database): string {
  const dataVersion = db.pragma("data_version", { simple: true });
  const changes = prepCached(db, "SELECT total_changes() AS n").get() as { n: number };
  return `${dataVersion}:${changes.n}`;
}

/**
 * Read every indexed session into the `SessionSummary[]` shape that
 * `scanAllSessions` produces. Returns `[]` when no sessions are indexed
 * — caller's façade falls back to file-parse in that case, mirroring
 * the empty-corpus behavior of the file-parse path.
 *
 * Rebuilt only when the index changed since the last call; otherwise the
 * last list is returned with `isActive` / `status`, the only fields that
 * depend on the clock, recomputed for now.
 */
export function loadSessionsListFromDb(db: DatabaseT.Database): SessionSummary[] {
  const key = indexChangeKey(db);
  const now = Date.now();
  let memo = memoHolder.__minderSessionsListMemo;
  if (!memo || memo.db !== db || memo.key !== key) {
    const clock: SessionsListMemo["clock"] = [];
    const sessions = buildSessionsList(db, now, clock);
    memo = memoHolder.__minderSessionsListMemo = { db, key, sessions, clock };
  }
  // Shallow copies, so a caller that edits a summary can't change the memo.
  const { sessions, clock } = memo;
  return sessions.map((s, i) => {
    const { storedStatus, fileMtimeMs } = clock[i];
    const isActive = now - fileMtimeMs < ACTIVE_WINDOW_MS;
    return { ...s, isActive, status: computeStatus(storedStatus, fileMtimeMs, now, isActive) };
  });
}

/** How recently a transcript must have been written for its session to count as active. */
const ACTIVE_WINDOW_MS = 2 * 60_000;

function buildSessionsList(
  db: DatabaseT.Database,
  now: number,
  clock: SessionsListMemo["clock"],
): SessionSummary[] {
  const headers = prepCached(
    db,
    `SELECT session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
            start_ts, end_ts, status,
            turn_count, user_turn_count, assistant_turn_count,
            error_count,
            input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
            cost_usd, cache_hit_ratio, max_context_fill,
            has_compaction_loop, has_tool_failure_streak,
            verified_task_count, one_shot_task_count,
            git_branch, initial_prompt, last_prompt,
            slug, continued_from_session_id,
            has_thinking, cli_version, has_resume_anomaly, compact_boundary_count,
            generated_title, starred_at, distilled_at, distilled_text,
            work_mode_exploration_pct, work_mode_building_pct,
            work_mode_testing_pct, work_mode_other_pct,
            source,
            session_kind, ai_title, entrypoint,
            derived_version
     FROM sessions
     -- turn_count counts PRIMARY turns only. Sidechain-only rows (subagent
     -- transcripts ingested from <session>/subagents/*.jsonl — needed so
     -- their token spend reaches the usage rollups) aren't sessions the
     -- user ran and would render as blank zero-turn cards; keep them out
     -- of the browser.
     WHERE turn_count > 0
     ORDER BY end_ts DESC`
  ).all() as SessionRow[];

  if (headers.length === 0) return [];

  // Stitch per-session breakdown maps. Each query returns flat rows
  // keyed by session_id; we group in JS into Maps the assembly loop
  // below reads from in O(1).
  const toolsBySession = groupCounts(
    prepCached(
      db,
      `SELECT session_id, tool_name, COUNT(*) AS n
       FROM tool_uses
       GROUP BY session_id, tool_name`
    ).all() as ToolCountRow[],
    (r) => [r.session_id, r.tool_name, r.n]
  );

  // #395: what the delegation roll-up needs, over ALL sessions — not just the
  // ones in `headers`. Subagent transcripts are excluded from the header query
  // by `turn_count > 0` (they are not sessions the user ran), yet their tool
  // calls are exactly what the roll-up is for. Querying them separately is the
  // point, not an oversight.
  const sidechainToolsBySession = groupCounts(
    prepCached(
      db,
      `SELECT session_id, tool_name, COUNT(*) AS n
       FROM sidechain_tool_uses
       GROUP BY session_id, tool_name`
    ).all() as ToolCountRow[],
    (r) => [r.session_id, r.tool_name, r.n]
  );
  // Parent linkage comes from `file_path`, NOT from a stored column, and the
  // difference is load-bearing. A column would be stamped by the same parse
  // that stamps `derived_version`, so a child not yet re-derived would carry no
  // link — and this loop would not see it, the version check below would have
  // nothing stale to reject, and the root's own counts would be returned as a
  // complete tree. The sessions whose link is missing are exactly the ones the
  // gate exists to catch (Codex review of #428). `file_path` is present on
  // every row at every version, so a stale child is always visible here and is
  // rejected on its version instead.
  const derivedVersionById = new Map<string, number>();
  const childrenByParent = new Map<string, string[]>();
  for (const r of prepCached(
    db,
    `SELECT session_id, file_path, derived_version FROM sessions`
  ).all() as Array<{
    session_id: string;
    file_path: string;
    derived_version: number;
  }>) {
    derivedVersionById.set(r.session_id, r.derived_version);
    const parent = parseSubagentParentSessionId(r.file_path);
    if (parent) {
      const siblings = childrenByParent.get(parent);
      if (siblings) siblings.push(r.session_id);
      else childrenByParent.set(parent, [r.session_id]);
    }
  }
  const delegationTreeSource: DelegationTreeSource = {
    derivedVersion: derivedVersionById,
    childrenByParent,
    primaryTools: toolsBySession,
    sidechainTools: sidechainToolsBySession,
  };

  // A2: per-session effort histogram. `is_sidechain = 0` matches the
  // file-parse path, where a subagent's turns live in a separate transcript
  // file and so never reach the parent session's mix.
  //
  // `effort IS NOT NULL` is what makes absence survive: a session with no
  // effort-carrying turns gets no row here at all, so the assembly below
  // reads `undefined` rather than `{}`. An empty object would render as a
  // chip showing zero of every level for a session that predates the field.
  const effortMixBySession = groupCounts(
    prepCached(
      db,
      `SELECT session_id, effort, COUNT(*) AS n
       FROM turns
       WHERE role = 'assistant' AND is_sidechain = 0
         AND effort IS NOT NULL AND effort != ''
       GROUP BY session_id, effort`
    ).all() as EffortCountRow[],
    (r) => [r.session_id, r.effort, r.n]
  );

  const skillsBySession = groupCounts(
    prepCached(
      db,
      `SELECT session_id, skill_name, COUNT(*) AS n
       FROM tool_uses
       WHERE skill_name IS NOT NULL
       GROUP BY session_id, skill_name`
    ).all() as SkillCountRow[],
    (r) => [r.session_id, r.skill_name, r.n]
  );

  const modelsBySession = groupModels(
    prepCached(
      db,
      `SELECT DISTINCT session_id, model
       FROM turns
       WHERE role = 'assistant' AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'`
    ).all() as ModelRow[]
  );

  // T2.2: PRs harvested from `gh pr create` tool_result text at ingest.
  // Empty for sessions that never created a PR — single SELECT bulk-fetch
  // keeps this O(table-scan) once instead of N per-session queries.
  const prsBySession = groupPrs(
    prepCached(
      db,
      `SELECT session_id, pr_url, pr_number, repo, source
       FROM session_prs
       ORDER BY session_id, pr_number, repo, pr_url`
    ).all() as PrRow[]
  );

  // item3: tickets referenced in each session — same single bulk-fetch
  // posture as PRs. Empty for sessions that never mention a tracker URL.
  const ticketsBySession = groupTickets(
    prepCached(
      db,
      `SELECT session_id, url, provider, ticket_key
       FROM session_tickets
       ORDER BY session_id, provider, ticket_key, url`
    ).all() as TicketRow[]
  );

  const result: SessionSummary[] = [];
  for (const h of headers) {
    const toolUsage = toolsBySession.get(h.session_id) ?? {};
    const skillsUsed = skillsBySession.get(h.session_id) ?? {};
    const modelsUsed = modelsBySession.get(h.session_id) ?? [];

    const isActive = now - h.file_mtime_ms < ACTIVE_WINDOW_MS;
    const status = computeStatus(h.status, h.file_mtime_ms, now, isActive);
    clock.push({ storedStatus: h.status, fileMtimeMs: h.file_mtime_ms });
    // Clipped once projected, so the memo does not hold the full prompts
    // (#704) and the lastPrompt suppression compares them whole (Codex, PR #709).
    result.push(clipSummaryPrompts({
      // **The shared projection (#496).** Every field both backends can
      // produce is derived here rather than beside its counterpart in
      // `buildAdapterScannedSession` — identity, counts, tokens, duration,
      // the lastPrompt suppression, oneShotRate's zero-guard, workMode's
      // all-or-nothing rule, and the two-source worktree check.
      ...projectSessionSummary({
        sessionId: h.session_id,
        source: h.source ?? "claude",
        filePath: h.file_path,
        projectDirName: h.project_dir_name,
        projectSlug: h.project_slug,
        startTs: h.start_ts,
        endTs: h.end_ts,
        initialPrompt: h.initial_prompt,
        lastPrompt: h.last_prompt,
        turnCount: h.turn_count,
        userTurnCount: h.user_turn_count,
        assistantTurnCount: h.assistant_turn_count,
        inputTokens: h.input_tokens,
        outputTokens: h.output_tokens,
        cacheReadTokens: h.cache_read_tokens,
        cacheCreateTokens: h.cache_create_tokens,
        errorCount: h.error_count,
        verifiedTaskCount: h.verified_task_count,
        oneShotTaskCount: h.one_shot_task_count,
        cacheHitRatio: h.cache_hit_ratio,
        gitBranch: h.git_branch,
        workModeExplorationPct: h.work_mode_exploration_pct,
        workModeBuildingPct: h.work_mode_building_pct,
        workModeTestingPct: h.work_mode_testing_pct,
        workModeOtherPct: h.work_mode_other_pct,
        toolUsage,
        skillsUsed,
        modelsUsed,
        searchableText: undefined,
      }),
      recaps: undefined,
      // Stored at ingest. File-parse reprices live from token buckets instead
      // (#494), which is why the projection takes neither side's answer.
      costEstimate: h.cost_usd,
      // Derived from a stored snapshot + the clock, where file-parse derives
      // from unresolved tool-use pairs. Different inputs, deliberately.
      isActive,
      status,
      // ── DB-only below: derived by post-reconcile passes the file backend
      //    does not run, or read from tables it has no equivalent of. ───────
      // #395: the same calls counted over the whole tree instead of the root
      // turn set, or undefined when the index cannot yet see the tree.
      treeDelegation: rollUpTreeDelegation(h.session_id, delegationTreeSource),
      slug: h.slug ?? undefined,
      continuedFromSessionId: h.continued_from_session_id ?? undefined,
      maxContextFill: h.max_context_fill ?? undefined,
      hasCompactionLoop: h.has_compaction_loop === 1,
      hasToolFailureStreak: h.has_tool_failure_streak === 1,
      hasThinking: h.has_thinking === 1 || undefined,
      cliVersion: h.cli_version ?? undefined,
      sessionKind: h.session_kind ?? undefined,
      // Deliberately no `?? {}` — see the query comment.
      effortMix: effortMixBySession.get(h.session_id),
      aiTitle: h.ai_title ?? undefined,
      entrypoint: h.entrypoint ?? undefined,
      hasResumeAnomaly: h.has_resume_anomaly === 1 || undefined,
      compactBoundaryCount: h.compact_boundary_count || undefined,
      generatedTitle: h.generated_title ?? undefined,
      starredAt: h.starred_at ?? undefined,
      distilledAt: h.distilled_at ?? undefined,
      distilledText: h.distilled_text ?? undefined,
      prs: prsBySession.get(h.session_id),
      tickets: ticketsBySession.get(h.session_id),
    }));
  }

  return result;
}

interface PrRow {
  session_id: string;
  pr_url: string;
  pr_number: number;
  repo: string;
  source: string | null;
}

function groupPrs(rows: PrRow[]): Map<string, PrLink[]> {
  const map = new Map<string, PrLink[]>();
  for (const r of rows) {
    const list = map.get(r.session_id);
    const link: PrLink = {
      url: r.pr_url,
      number: r.pr_number,
      repo: r.repo,
      // NULL = indexed before v22, which is NOT the same as "scraped".
      source: toPrLinkSource(r.source),
    };
    if (list) list.push(link);
    else map.set(r.session_id, [link]);
  }
  return map;
}

interface TicketRow {
  session_id: string;
  url: string;
  provider: string;
  ticket_key: string;
}

function groupTickets(rows: TicketRow[]): Map<string, TicketLink[]> {
  const map = new Map<string, TicketLink[]>();
  for (const r of rows) {
    const list = map.get(r.session_id);
    const link: TicketLink = {
      url: r.url,
      provider: r.provider as TicketLink["provider"],
      key: r.ticket_key,
    };
    if (list) list.push(link);
    else map.set(r.session_id, [link]);
  }
  return map;
}

/**
 * Time-gated status resolution. Combines the stored snapshot from
 * ingest (P2c) with `file_mtime_ms` to produce the same
 * `working | idle | needs_attention` verdict as `inferSessionStatus`
 * (`src/lib/scanner/sessionStatus.ts`) — but freshness comes from the
 * mtime watermark, which advances on every tail-append, so the live
 * "is this session active right now" answer stays correct without
 * re-ingesting on every dashboard tick.
 *
 *   stored=`'waiting'` (had pendings):
 *     mtime fresh < 90 s    → `working`
 *     mtime in [90 s, 10 m] → `needs_attention`
 *     mtime older > 10 m    → `idle`  (abandoned snapshot)
 *   stored=`'inactive'` (no pendings)  → `idle`
 *   stored=NULL (legacy row, not yet re-ingested with status):
 *     fall back to the original 2-min mtime heuristic (working/idle).
 *   any other stored value (forward-compat / unexpected):
 *     same fallback as NULL.
 *
 * The 90 s and 10 min thresholds match `WORKING_MS` and `STALE_MS` in
 * `sessionStatus.ts`. Kept in sync with the canonical impl.
 */
const STATUS_WORKING_MS = 90_000;
const STATUS_STALE_MS = 10 * 60_000;
function computeStatus(
  stored: string | null,
  fileMtimeMs: number,
  now: number,
  isActive: boolean
): SessionStatus {
  const ageMs = now - fileMtimeMs;
  if (stored === "waiting") {
    if (ageMs < STATUS_WORKING_MS) return "working";
    if (ageMs > STATUS_STALE_MS) return "idle";
    return "needs_attention";
  }
  if (stored === "inactive") return "idle";
  // Legacy / unexpected — preserve the pre-P2c heuristic.
  return isActive ? "working" : "idle";
}

function groupCounts<T>(
  rows: T[],
  pick: (row: T) => [sessionId: string, key: string, count: number]
): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const [sid, key, n] = pick(row);
    let bucket = map.get(sid);
    if (!bucket) {
      bucket = {};
      map.set(sid, bucket);
    }
    bucket[key] = n;
  }
  return map;
}

function groupModels(rows: ModelRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    let bucket = map.get(row.session_id);
    if (!bucket) {
      bucket = [];
      map.set(row.session_id, bucket);
    }
    bucket.push(row.model);
  }
  return map;
}
