import "server-only";
import type DatabaseT from "better-sqlite3";
import { decodeDirName } from "@/lib/platform";
import { prepCached } from "@/lib/db/connection";
import type { SessionSummary, SessionStatus } from "@/lib/types";

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
// 2. `searchableText`: `undefined` (was: human prompts + assistant text
//    snippets joined to ~4000 chars). **UI consequence**: the content
//    search in `SessionsBrowser.tsx` (the `searchableText?.toLowerCase()
//    .includes(...)` branch) silently filters out everything when it's
//    undefined, so content-text search becomes a no-op for sessions
//    served from the DB backend. Could be reconstructed from
//    `prompts_fts` later (the data is already there); deferred until a
//    follow-up slice.
// 3. `status`: heuristic from file age — `working` if `isActive`,
//    `idle` otherwise. The file-parse `inferSessionStatus` (in
//    `src/lib/scanner/sessionStatus.ts`) walks the last 500 entries
//    for unpaired tool_use IDs and can also return `needs_attention`
//    when there are pending tool calls and the file has gone stale.
//    The DB path **never** emits `needs_attention`. UI consequence:
//    any future surface that branches on `status === "needs_attention"`
//    would silently miss the case under MINDER_USE_DB.
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
//    and `turns` skips sidechain / meta / non-(user|assistant) entries
//    (`src/lib/db/ingest.ts:352-357`). File-parse's `scanSessionFile`
//    walks every JSONL entry's `timestamp` (`claudeConversations.ts:148-151`).
//    For sessions with sidechain or system entries before the first
//    user turn or after the last assistant turn, the DB path's
//    `startTime` / `endTime` (and therefore `durationMs`) can fall
//    inside the file-parse window — the file-parse window strictly
//    contains the DB window, never the reverse.

interface SessionRow {
  session_id: string;
  project_slug: string | null;
  project_dir_name: string;
  file_mtime_ms: number;
  start_ts: string | null;
  end_ts: string | null;
  turn_count: number;
  user_turn_count: number;
  assistant_turn_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  verified_task_count: number;
  one_shot_task_count: number;
  git_branch: string | null;
  initial_prompt: string | null;
  last_prompt: string | null;
}

interface ToolCountRow {
  session_id: string;
  tool_name: string;
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
 * Read every indexed session into the `SessionSummary[]` shape that
 * `scanAllSessions` produces. Returns `[]` when no sessions are indexed
 * — caller's façade falls back to file-parse in that case, mirroring
 * the empty-corpus behavior of the file-parse path.
 */
export function loadSessionsListFromDb(db: DatabaseT.Database): SessionSummary[] {
  const headers = prepCached(
    db,
    `SELECT session_id, project_slug, project_dir_name, file_mtime_ms,
            start_ts, end_ts,
            turn_count, user_turn_count, assistant_turn_count,
            error_count,
            input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
            cost_usd, verified_task_count, one_shot_task_count,
            git_branch, initial_prompt, last_prompt
     FROM sessions
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
       WHERE role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'`
    ).all() as ModelRow[]
  );

  const now = Date.now();
  const result: SessionSummary[] = [];
  for (const h of headers) {
    const toolUsage = toolsBySession.get(h.session_id) ?? {};
    const skillsUsed = skillsBySession.get(h.session_id) ?? {};
    const modelsUsed = modelsBySession.get(h.session_id) ?? [];

    const isActive = now - h.file_mtime_ms < 2 * 60_000;
    const status: SessionStatus = isActive ? "working" : "idle";
    const durationMs =
      h.start_ts && h.end_ts
        ? new Date(h.end_ts).getTime() - new Date(h.start_ts).getTime()
        : undefined;

    const oneShotRate =
      h.verified_task_count > 0
        ? h.one_shot_task_count / h.verified_task_count
        : undefined;

    // Match file-parse: suppress lastPrompt when identical to initialPrompt
    // so single-prompt sessions don't render the same text twice.
    const lastPrompt =
      h.last_prompt && h.last_prompt !== h.initial_prompt
        ? h.last_prompt
        : undefined;

    result.push({
      sessionId: h.session_id,
      projectPath: decodeDirName(h.project_dir_name),
      // `project_slug` is set at ingest via `toSlug(canonicalDir)` so
      // it should never be NULL on a healthy index. Schema permits NULL
      // though, so fall back to deriving the same slug on the fly
      // rather than serving an empty string downstream — `SessionsBrowser`'s
      // project filter and grouping both key on a non-empty slug.
      projectSlug: h.project_slug ?? slugifyDirName(h.project_dir_name),
      projectName: h.project_dir_name,
      startTime: h.start_ts ?? undefined,
      endTime: h.end_ts ?? undefined,
      durationMs,
      initialPrompt: h.initial_prompt ?? undefined,
      lastPrompt,
      recaps: undefined,
      messageCount: h.turn_count,
      userMessageCount: h.user_turn_count,
      assistantMessageCount: h.assistant_turn_count,
      inputTokens: h.input_tokens,
      outputTokens: h.output_tokens,
      cacheReadTokens: h.cache_read_tokens,
      cacheCreateTokens: h.cache_create_tokens,
      costEstimate: h.cost_usd,
      toolUsage,
      modelsUsed,
      gitBranch: h.git_branch ?? undefined,
      // file-parse counts every Agent tool_use block (line 196 of
      // claudeConversations.ts); the indexed `toolUsage['Agent']`
      // tally is the same number from the same source, modulo
      // sidechain skipping (divergence #4).
      subagentCount: toolUsage["Agent"] ?? 0,
      errorCount: h.error_count,
      isActive,
      status,
      skillsUsed,
      oneShotRate,
      searchableText: undefined,
    });
  }

  return result;
}

/**
 * Inline mirror of `toSlug` from `src/lib/scanner/claudeConversations.ts`.
 * Duplicated here (3 lines) so this file can stay free of the heavy
 * scanner module — the scanner pulls in pricing, fs caches, etc., which
 * we don't need on the read path. Kept in sync with the original; if
 * the slugification rule changes, both must move together.
 */
function slugifyDirName(dirName: string): string {
  const parts = dirName.split("-");
  const meaningful = parts.slice(parts.findIndex((p) => p.length > 1));
  return meaningful.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
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
