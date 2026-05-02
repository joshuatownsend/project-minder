import "server-only";
import type DatabaseT from "better-sqlite3";
import type { ClaudeUsageStats } from "@/lib/types";
import { encodePath } from "@/lib/scanner/claudeConversations";

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
// **Documented divergence** — `costEstimate` under DB mode reads the
// pre-computed `sessions.cost_usd` (per-turn `applyPricing` at ingest)
// rather than the file-parse path's `loadPricing` + `getModelPricing`
// post-aggregation pass. The file-parse path also has a quirk: cache-
// hit files lack per-model breakdown and bucket their tokens as
// "unknown" → sonnet-fallback pricing. The DB path knows the actual
// model on every row, so its `costEstimate` is **more accurate** when
// the corpus contains rows attributed to non-sonnet models. Treat as
// an improvement, not a regression. The `needsReconcileAfterV3` gate
// in the façade prevents serving zeroed cost during the v3 catch-up.

interface TotalsRow {
  conversation_count: number;
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
  // `scanClaudeConversationsForProjects` would consider.
  const allowedDirs = projectPaths.map((p) => encodePath(p));
  const placeholders = allowedDirs.map(() => "?").join(",");

  // One prepare per call (variable-shape SQL). The route's 10-min
  // cache absorbs the per-prepare cost; under churn that's pennies.
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS conversation_count,
              COALESCE(SUM(turn_count), 0) AS total_turns,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(error_count), 0) AS error_count
       FROM sessions
       WHERE project_dir_name IN (${placeholders})`
    )
    .get(...allowedDirs) as TotalsRow;

  if (totals.conversation_count === 0) return stats;

  stats.conversationCount = totals.conversation_count;
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
       GROUP BY tu.tool_name`
    )
    .all(...allowedDirs) as ToolRow[];

  for (const t of tools) {
    stats.toolUsage[t.tool_name] = t.n;
  }

  // `<synthetic>` is the file-parse path's "no model" sentinel for
  // turns that don't have a real assistant model (e.g. system-only
  // entries). Both backends exclude it from `modelsUsed`.
  const models = db
    .prepare(
      `SELECT DISTINCT t.model AS model
       FROM turns t
       JOIN sessions s USING (session_id)
       WHERE s.project_dir_name IN (${placeholders})
         AND t.role = 'assistant'
         AND t.model IS NOT NULL
         AND t.model <> '<synthetic>'`
    )
    .all(...allowedDirs) as ModelRow[];

  stats.modelsUsed = models.map((m) => m.model);

  return stats;
}
