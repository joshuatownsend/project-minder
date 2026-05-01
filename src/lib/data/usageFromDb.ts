import "server-only";
import type DatabaseT from "better-sqlite3";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";

// SQLite-backed rehydrate of `UsageTurn[]` for the `/api/usage` route.
//
// **Why rehydrate then aggregate** instead of running SQL aggregates
// directly: `aggregator.ts` runs classification, per-turn cost, one-shot
// detection, shell-binary parsing, and per-MCP rollups. Several of those
// derive from per-turn JS state that the schema currently doesn't store
// pre-aggregated. The realistic structural perf win — SUM(...) GROUP BY
// per dimension — needs schema additions (`turns.cost_usd`, a
// `category_costs` rollup) that ship in a follow-up slice. Until then,
// this path's win is "skip the 1.1 GB JSONL re-parse"; it still runs the
// same in-JS aggregation as the file-parse backend.
//
// Period filtering happens in SQL: `WHERE turns.ts >= @periodStart`
// against the indexed `turns_by_role_ts` index. Project filtering joins
// `sessions` and filters on `project_slug`.
//
// **Truncation parity**: `text_preview` (500 chars) and
// `tool_result_preview` (2000 chars) match the limits applied by
// `parser.ts` in the file-parse path, so `classifyTurn` and
// `detectOneShot` consume identical inputs across backends. No drift.

// Mirrors `parseStoredArgs` in `src/lib/db/ingest.ts`. Kept as a local
// copy to avoid the data layer reaching back into the indexer's internals.
const COMMAND_RECOVERY_RE = /"command"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/;
function parseStoredArgs(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    const match = COMMAND_RECOVERY_RE.exec(json);
    if (!match) return undefined;
    try {
      const value = JSON.parse(`"${match[1]}"`) as string;
      return { command: value };
    } catch {
      return undefined;
    }
  }
}

export function periodStartIso(period: string, now: Date = new Date()): string | null {
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return start.toISOString();
    }
    case "all":
      return null;
    default:
      return null;
  }
}

interface TurnRow {
  session_id: string;
  project_slug: string | null;
  project_dir_name: string;
  turn_index: number;
  ts: string;
  role: "user" | "assistant";
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  is_error: number;
  text_preview: string | null;
  tool_result_preview: string | null;
}

interface ToolRow {
  session_id: string;
  turn_index: number;
  tool_name: string;
  arguments_json: string | null;
}

/**
 * Load turns + tool_uses for the given period/project filter and
 * reconstruct the `UsageTurn[]` shape the aggregator consumes.
 *
 * Sort order matches the file-parse path: ascending by (sessionId,
 * turn_index). The aggregator depends on this for `detectOneShot`'s
 * sliding-window scan over per-session sequences.
 */
export function loadFilteredUsageTurns(
  db: DatabaseT.Database,
  period: string,
  project?: string
): UsageTurn[] {
  const periodStart = periodStartIso(period);

  const turnSql = `
    SELECT
      t.session_id,
      s.project_slug,
      s.project_dir_name,
      t.turn_index,
      t.ts,
      t.role,
      t.model,
      t.input_tokens,
      t.output_tokens,
      t.cache_create_tokens,
      t.cache_read_tokens,
      t.is_error,
      t.text_preview,
      t.tool_result_preview
    FROM turns t
    JOIN sessions s ON s.session_id = t.session_id
    WHERE
      (@periodStart IS NULL OR t.ts >= @periodStart)
      AND (@project IS NULL OR s.project_slug = @project)
    ORDER BY t.session_id, t.turn_index
  `;

  const turnRows = db.prepare(turnSql).all({
    periodStart,
    project: project ?? null,
  }) as TurnRow[];

  if (turnRows.length === 0) return [];

  // Two-step load: turns first, then tool_uses for ONLY the sessions we
  // saw. SQLite's IN list with parameter bindings is fine up to a few
  // thousand entries; default SQLITE_LIMIT_VARIABLE_NUMBER is 32 766 in
  // recent builds. We chunk by 500 to stay well under that and to keep
  // each prepared statement cacheable.
  const sessionIds = Array.from(new Set(turnRows.map((r) => r.session_id)));
  const toolsByTurn = new Map<string, ToolCall[]>();
  const CHUNK = 500;
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const toolSql = `
      SELECT session_id, turn_index, tool_name, arguments_json
      FROM tool_uses
      WHERE session_id IN (${placeholders})
      ORDER BY session_id, turn_index, sequence_in_turn
    `;
    const rows = db.prepare(toolSql).all(...chunk) as ToolRow[];
    for (const r of rows) {
      const key = `${r.session_id}:${r.turn_index}`;
      const list = toolsByTurn.get(key) ?? [];
      list.push({ name: r.tool_name, arguments: parseStoredArgs(r.arguments_json) });
      toolsByTurn.set(key, list);
    }
  }

  return turnRows.map((r): UsageTurn => {
    const key = `${r.session_id}:${r.turn_index}`;
    const isUser = r.role === "user";
    return {
      timestamp: r.ts,
      sessionId: r.session_id,
      projectSlug: r.project_slug ?? "",
      projectDirName: r.project_dir_name,
      model: r.model ?? "",
      role: r.role,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreateTokens: r.cache_create_tokens,
      cacheReadTokens: r.cache_read_tokens,
      toolCalls: toolsByTurn.get(key) ?? [],
      isError: r.is_error === 1,
      // Match `parser.ts` exactly: only user turns carry text/tool-result
      // previews. Assistant turns leave both undefined.
      userMessageText: isUser ? (r.text_preview ?? undefined) : undefined,
      toolResultText: isUser ? (r.tool_result_preview ?? undefined) : undefined,
    };
  });
}

/**
 * Max `file_mtime_ms` across all sessions. Analog of `getJsonlMaxMtime`
 * for the file-parse path — used as the ETag input so cached responses
 * invalidate when any session JSONL grows or rotates. The indexer's
 * `appendSessionTail` updates `file_mtime_ms` on every tail, so this
 * advances as soon as a file changes.
 */
export function getDbMaxMtimeMs(db: DatabaseT.Database): number {
  const row = db
    .prepare("SELECT MAX(file_mtime_ms) AS m FROM sessions")
    .get() as { m: number | null } | undefined;
  return row?.m ?? 0;
}
