import "server-only";
import type DatabaseT from "better-sqlite3";
import type { ClaudeUsageStats } from "@/lib/types";
import { parseSubagentParentSessionId } from "@/lib/sessions/subagentTranscriptPath";

// SQL-backed Claude conversation aggregator for `/api/stats`. Replaces
// the `parseAllSessions` + `scanClaudeConversationsForProjects` pair in
// the route — both of which walk every JSONL in `~/.claude/projects/`
// and accumulate per-token / per-tool / per-model totals. The DB path
// reads the same totals as SUM(...)/GROUP BY queries against the
// indexed `sessions` / `turns` / `tool_uses` rows.
//
// Filter shape: `scanClaudeConversationsForProjects(projectPaths)`
// builds `Set(projectPaths.map(encodePath))` and skips dir names not in
// the set. The DB analog is `WHERE sessions.project_dir_name IN (?, ?,
// ...)`. The placeholder count is variable (one per project), so this
// query is built with `db.prepare()` directly rather than `prepCached`
// — same pattern as `queryProjectDetails` in `usageFromDb.ts`. Caller
// pays one prepare per refresh; that's fine because /api/stats has its
// own 10-minute in-route cache layered above.
//
// `encodePath` is inlined here as a 3-character regex replace rather
// than imported from `@/lib/scanner/claudeConversations` — that module
// pulls in the full file-parse pipeline (pricing, fs caches, every
// scanner helper), and the read path shouldn't carry that weight at
// boot just to do a path-to-dirname encoding. Kept in sync with the
// canonical impl at `claudeConversations.ts:51`; if the encoding rule
// changes both must move together.
//
// **Documented divergences from the file-parse path:**
//
// 1. `costEstimate` under DB mode reads the pre-computed
//    `sessions.cost_usd` (per-turn `applyPricing` at ingest) rather
//    than the file-parse path's `loadPricing` + `getModelPricing`
//    post-aggregation pass. The file-parse path also has a quirk:
//    cache-hit files lack per-model breakdown and bucket their tokens
//    as "unknown" → sonnet-fallback pricing. The DB path knows the
//    actual model on every row, so its `costEstimate` is **more
//    accurate** when the corpus contains rows attributed to non-sonnet
//    models. Treat as an improvement, not a regression. The
//    `needsReconcileAfterV3` gate in the façade prevents serving
//    zeroed cost during the v3 catch-up.
//
// 2. **Worktree sessions roll up to the parent project under DB.**
//    Ingest applies `canonicalizeDirName` (`src/lib/usage/parser.ts:58`)
//    which strips the `--<word>-worktrees-...` suffix from worktree
//    dirs, so a session originating from
//    `C--dev-my-app--claude-worktrees-foo` is stored with
//    `project_dir_name = 'C--dev-my-app'`. File-parse uses raw dir
//    names (`scanClaudeConversationsForProjects` filters by
//    `encodePath(projectPath)` directly) — so the worktree dir name
//    `C--dev-my-app--claude-worktrees-foo` is NOT in the allowedDirs
//    set when the caller passes the parent path, and worktree
//    sessions are excluded entirely. Result: the DB-backed totals for
//    a parent project include its worktree work; the file-backed
//    totals don't. The DB behavior is arguably more useful (worktree
//    work IS work on the parent project), but it's a numeric
//    difference reviewers should know about. Closing the divergence
//    would require either tracking the original (non-canonicalized)
//    dir name in the schema or walking the projects directory at
//    query time to discover worktree dirs — both deferred.
//
// 3. **Nested subagent transcripts are excluded from
//    `conversationCount`** (#480). Ingest indexes
//    `<project>/<parent>/subagents/agent-*.jsonl` as its own `sessions`
//    row so its cost reaches the daily_costs rollups, but the session
//    row's own aggregates are primary-only (`is_sidechain = 0`, see
//    `ingest.ts:2834`), so such a row contributes **zero** turns and
//    zero tokens here. Counting it as a conversation was therefore
//    incoherent even ignoring parity: on the reference index 1,268 of
//    6,799 rows (18.6%, and up to 94% for a single project) are nested,
//    so a project reporting 69 conversations had 4. File-parse never
//    sees these files at all — it reads immediate `.jsonl` entries only
//    — which is what made this a backend divergence as well as a
//    miscount.
//
//    This is the same product decision `loadSessionsListFromDb` already
//    made at its `WHERE turn_count > 0` filter ("aren't sessions the
//    user ran"); the two exclusions are one decision, not two filters
//    that happen to agree. Fixing it at ingest instead is wrong — the
//    rows exist on purpose, and dropping them would break the /usage
//    rollups that fold subagent cost in.
//
//    Note the /usage surface is NOT affected and needs no matching
//    change: `usageFromDb`'s session count is over `turns`, and its
//    file-parse counterpart (`usage/parser.ts:716`) already walks
//    `subagents/`, so both sides include them there by design.
//
// 4. **Claude sessions only** (#475). Every query here filters
//    `source = 'claude'`. This surface is the "Claude Code Usage" card;
//    its file-parse counterpart reads `<claude-home>/projects/**` and
//    is Claude-only by construction, so without the filter a machine
//    with Codex or Gemini sessions indexed would see those folded into
//    a Claude-labelled figure under the DB backend and not under the
//    file one.
//
//    This is the direction the other four corpus loaders do NOT take:
//    they gained adapter coverage on the file side instead (#475), so
//    they answer about every source on both backends. `getClaudeUsage`
//    is the one whose *question* is single-source, so the two are
//    equalized by narrowing the SQL rather than widening the walk.
//    `sessions.source` is `TEXT NOT NULL DEFAULT 'claude'`
//    (`migrations.ts:333`), so bare equality needs no COALESCE — checked
//    against the schema, not against the fact that every row on the
//    reference index happens to say `claude`.

/** Sum one numeric column across rows. */
function sum<T>(rows: T[], pick: (row: T) => number): number {
  let total = 0;
  for (const r of rows) total += pick(r) ?? 0;
  return total;
}

interface TotalsRow {
  row_count: number;
  total_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  error_count: number;
}

interface ToolRow {
  tool_name: string;
  n: number;
}

interface ModelRow {
  model: string;
}

/**
 * Build `ClaudeUsageStats` for the given project paths. Empty paths
 * list returns the zero stats shape (matches `scanConversationDirs`'s
 * empty-set behavior). Missing `sessions` rows for the filter set
 * return the zero shape; caller's façade promotes that to a fall-
 * through if the indexer is still warming up.
 */
export function loadClaudeUsageStatsFromDb(
  db: DatabaseT.Database,
  projectPaths: string[]
): ClaudeUsageStats {
  const stats: ClaudeUsageStats = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTurns: 0,
    toolUsage: {},
    errorCount: 0,
    modelsUsed: [],
    costEstimate: 0,
    conversationCount: 0,
  };

  if (projectPaths.length === 0) return stats;

  // Use the same path-encoding as the file-parse filter so the IN-list
  // matches the same set of `~/.claude/projects/<dir>` entries that
  // `scanClaudeConversationsForProjects` would consider. See header
  // comment for why `encodePath` is inlined here rather than imported.
  const allowedDirs = projectPaths.map(encodePathLite);
  const placeholders = allowedDirs.map(() => "?").join(",");

  // **One SQLite snapshot for every read below** (Codex P2, PR #488). The
  // indexer commits from a separate worker while this runs, so without a read
  // transaction the queries here each see whatever was committed at the moment
  // they ran. That was harmless while `conversation_count` was a column of the
  // same aggregate as the token totals; splitting it into its own `file_path`
  // query is what let the two describe different database states — a count that
  // includes a session whose tokens are absent, or the reverse, then cached by
  // `/api/stats` for ten minutes. The tool and model queries join the same
  // transaction rather than being left as they were: they were already separate
  // statements, and the fix is not worth doing by halves.
  //
  // `db.transaction()` nests through savepoints, so this is safe if a caller is
  // already inside one.
  return db.transaction(() => collectStats(db, stats, allowedDirs, placeholders))();
}

/**
 * The query body of `loadClaudeUsageStatsFromDb`, extracted so it can run
 * inside a single read transaction. Mutates and returns the `stats` object it
 * is handed. Must stay synchronous — better-sqlite3 transaction functions
 * cannot be async.
 */
function collectStats(
  db: DatabaseT.Database,
  stats: ClaudeUsageStats,
  allowedDirs: string[],
  placeholders: string
): ClaudeUsageStats {

  // One prepare per call (variable-shape SQL). The route's 10-min
  // cache absorbs the per-prepare cost; under churn that's pennies.
  //
  // Summed in JS over the rows rather than by SQL, because the subagent
  // transcripts have to come out first (#487). They used to fall out on their
  // own: a nested transcript's session row carried `turn_count = 0` and zero
  // tokens, because every one of its turns was stored as a sidechain and the
  // session aggregates are primary-only. #487 ingests those turns as the
  // subagent's own conversation — which is what stopped it opening to a blank
  // timeline — so the row now carries real numbers, and a plain SUM would add
  // them here.
  //
  // That would be a BACKEND DIVERGENCE, not a correction: `scanClaudeConversations`
  // reads only `*.jsonl` directly inside a project directory and never descends
  // into `<session>/subagents/`, so the file-parse side cannot see them at all.
  // The same predicate that already excludes them from `conversationCount`
  // therefore has to exclude them from the totals, and the numbers this surface
  // reports are unchanged by #487.
  //
  // Their spend is not lost: `getUsage` sums over `turns`, where these rows have
  // always been counted (DERIVED_VERSION 10 folded subagent tokens into the
  // usage totals deliberately). This surface is session-level and single-source,
  // and its file-parse counterpart defines the corpus.
  const rows = db
    .prepare(
      `SELECT session_id, file_path, turn_count, input_tokens, output_tokens,
              cache_create_tokens, cache_read_tokens, cost_usd, error_count
       FROM sessions
       WHERE project_dir_name IN (${placeholders})
         AND source = 'claude'`
    )
    .all(...allowedDirs) as Array<
    { session_id: string; file_path: string } & Omit<
      TotalsRow,
      "row_count" | "total_turns"
    > & { turn_count: number }
  >;

  const owned = rows.filter(
    (r) => parseSubagentParentSessionId(r.file_path) === undefined
  );
  const totals: TotalsRow = {
    row_count: rows.length,
    total_turns: sum(owned, (r) => r.turn_count),
    input_tokens: sum(owned, (r) => r.input_tokens),
    output_tokens: sum(owned, (r) => r.output_tokens),
    cache_create_tokens: sum(owned, (r) => r.cache_create_tokens),
    cache_read_tokens: sum(owned, (r) => r.cache_read_tokens),
    cost_usd: sum(owned, (r) => r.cost_usd),
    error_count: sum(owned, (r) => r.error_count),
  };

  // Zero indexed rows keeps the previous meaning: the façade reads a
  // zero `conversationCount` as "indexer warming up" and falls through
  // to file-parse. Gated on the RAW row count rather than the corrected
  // one so the fall-through still means "nothing indexed" — a project
  // holding only nested transcripts legitimately has zero conversations
  // and would otherwise be misreported as an empty index. (It falls
  // through to file-parse anyway in that case, which finds no top-level
  // `.jsonl` and returns the same zero shape.)
  if (totals.row_count === 0) return stats;

  // Counted in JS with the canonical predicate rather than as a SQL
  // `file_path NOT LIKE '%subagents%'`, deliberately. `sessionsListFromDb`
  // already SELECTs every `file_path` and applies this same function, and a
  // second, hand-copied definition of "is this a nested transcript" is the
  // exact failure this wave has been unwinding: in #483 five copies of one
  // regex agreed perfectly and were all wrong together. One predicate, one
  // definition. (A stored column was considered and rejected in that
  // module's docblock — a not-yet-re-derived row would silently have no
  // link.)
  // `owned` above is this same filter; the separate `file_path` query it used
  // to run has been folded into the row fetch rather than asking twice.
  stats.conversationCount = owned.length;
  stats.totalTurns = totals.total_turns;
  stats.inputTokens = totals.input_tokens;
  stats.outputTokens = totals.output_tokens;
  stats.cacheCreateTokens = totals.cache_create_tokens;
  stats.cacheReadTokens = totals.cache_read_tokens;
  stats.costEstimate = totals.cost_usd;
  stats.errorCount = totals.error_count;
  // Match file-parse: `totalTokens = inputTokens + outputTokens`
  // (cache tokens excluded — see scanClaudeConversations:734).
  stats.totalTokens = totals.input_tokens + totals.output_tokens;

  const tools = db
    .prepare(
      `SELECT tu.tool_name AS tool_name, COUNT(*) AS n
       FROM tool_uses tu
       JOIN sessions s USING (session_id)
       WHERE s.project_dir_name IN (${placeholders})
         AND s.source = 'claude'
       GROUP BY tu.tool_name`
    )
    .all(...allowedDirs) as ToolRow[];

  for (const t of tools) {
    stats.toolUsage[t.tool_name] = t.n;
  }

  // `<synthetic>` is the file-parse path's "no model" sentinel for
  // turns that don't have a real assistant model (e.g. system-only
  // entries). Both backends exclude it from `modelsUsed`.
  //
  // `t.is_sidechain = 0` no longer excludes subagent transcripts by itself
  // (#487): their turns are now stored as the subagent's own conversation, so
  // they are primary rows on a session of their own. Without the id filter, a
  // model used ONLY by a delegated agent would appear here while file-parse —
  // which never reads those files — reported it nowhere. Same reasoning as the
  // totals above, and the same single predicate.
  const models = db
    .prepare(
      `SELECT DISTINCT t.model AS model, s.session_id AS session_id
       FROM turns t
       JOIN sessions s USING (session_id)
       WHERE s.project_dir_name IN (${placeholders})
         AND s.source = 'claude'
         AND t.role = 'assistant'
         AND t.is_sidechain = 0
         AND t.model IS NOT NULL
         AND t.model <> '<synthetic>'`
    )
    .all(...allowedDirs) as Array<ModelRow & { session_id: string }>;

  const ownedIds = new Set(owned.map((r) => r.session_id));
  stats.modelsUsed = [
    ...new Set(
      models.filter((m) => ownedIds.has(m.session_id)).map((m) => m.model)
    ),
  ];

  return stats;
}

/**
 * Inlined mirror of `encodePath` from
 * `src/lib/scanner/claudeConversations.ts:51`. Three characters of
 * substitution; not worth importing the heavy scanner module just for
 * this. Kept in sync with the canonical impl — if encoding changes
 * both move together.
 */
function encodePathLite(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}
