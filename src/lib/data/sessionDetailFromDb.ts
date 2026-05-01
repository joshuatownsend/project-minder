import "server-only";
import type DatabaseT from "better-sqlite3";
import { decodeDirName } from "@/lib/platform";
import { parseStoredArgs } from "@/lib/db/storedArgs";
import type {
  SessionDetail,
  TimelineEvent,
  FileOperation,
  SubagentInfo,
  SessionStatus,
} from "@/lib/types";

// SQL-backed session detail loader. Mirrors `scanSessionDetail`'s output
// shape, building it from the indexed `sessions` / `turns` / `tool_uses`
// / `file_edits` tables instead of re-parsing the JSONL on every detail
// view. The cold path turns from "stat + read 50MB JSONL + parse" into
// "5 small SELECTs against indexed columns."
//
// **Documented divergences from the file-parse path**, all preserved
// here intentionally because the source data isn't in the index:
//
// 1. `recaps`: returned as `undefined` (was: parsed from
//    `entry.type === "system" && subtype === "away_summary"`). Ingest
//    skips non-user/non-assistant entries.
// 2. `searchableText`: returned as `undefined` (was: human prompts +
//    assistant text snippets joined). Could be rebuilt from
//    `prompts_fts` later if a UI feature actually consumes it.
// 3. `subagents.messageCount` / per-agent `toolUsage`: zeroed (was:
//    counted from sidechain assistant entries, which ingest skips).
//    Type and description ARE preserved from `tool_uses.agent_name` +
//    `arguments_json`. UI consequence: subagent tab shows the agent
//    list without the per-agent tool histogram.
// 4. `status`: heuristic from file age — `working` if `isActive`,
//    `idle` otherwise. The file-parse `inferSessionStatus` walks the
//    last 500 entries for unpaired tool_use IDs and can additionally
//    return `needs_attention` for stale-mtime-with-pending-tools; the
//    DB path **never** emits `needs_attention`. SessionDetailView
//    reads `data.isActive`, not `data.status`, so the loss is
//    invisible in today's UI — but any future surface that branches
//    on `status === "needs_attention"` would silently miss the case
//    when MINDER_USE_DB=1.
// 5. `bash` entries in `fileOperations`: derived from
//    `tool_uses WHERE tool_name='Bash'` rather than synthesized at
//    parse time. The `file_edits` table's CHECK constraint excludes
//    'bash', so we don't write them there — the read query joins
//    write/edit/delete from `file_edits` with bash from `tool_uses`.
//
// All numeric SessionSummary fields (token counts, message counts,
// costs, oneShotRate) and the timeline content match the file-parse
// path byte-for-byte.

interface SessionRow {
  session_id: string;
  project_slug: string | null;
  project_dir_name: string;
  file_mtime_ms: number;
  start_ts: string | null;
  end_ts: string | null;
  primary_model: string | null;
  turn_count: number;
  user_turn_count: number;
  assistant_turn_count: number;
  tool_call_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  has_one_shot: number;
  verified_task_count: number;
  one_shot_task_count: number;
  git_branch: string | null;
  initial_prompt: string | null;
  last_prompt: string | null;
}

interface TurnRow {
  turn_index: number;
  ts: string;
  role: "user" | "assistant";
  model: string | null;
  is_error: number;
  text_preview: string | null;
  output_tokens: number;
}

interface ToolRow {
  turn_index: number;
  sequence_in_turn: number;
  tool_use_id: string | null;
  ts: string | null;
  tool_name: string;
  agent_name: string | null;
  skill_name: string | null;
  arguments_json: string | null;
  file_path: string | null;
  file_op: string | null;
}

const TIMELINE_TEXT_LIMIT = 300;

/**
 * Look up a session by id and reconstruct the full `SessionDetail`
 * shape from indexed rows. Returns `null` when the session_id matches
 * no row — the caller's façade falls back to file-parse in that case
 * (handles the "session exists on disk but isn't indexed yet" edge).
 */
export function loadSessionDetailFromDb(
  db: DatabaseT.Database,
  sessionId: string
): SessionDetail | null {
  // SessionId-shape gate: same regex as `scanSessionDetail` — UUIDs and
  // hex-only — so a path-traversal attempt can't even hit the DB.
  if (!/^[a-f0-9-]+$/i.test(sessionId)) return null;

  const session = db
    .prepare(
      `SELECT session_id, project_slug, project_dir_name, file_mtime_ms,
              start_ts, end_ts, primary_model,
              turn_count, user_turn_count, assistant_turn_count,
              tool_call_count, error_count,
              input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
              cost_usd, has_one_shot, verified_task_count, one_shot_task_count,
              git_branch, initial_prompt, last_prompt
       FROM sessions
       WHERE session_id = ?`
    )
    .get(sessionId) as SessionRow | undefined;

  if (!session) return null;

  // `model` folded into the turns SELECT so we can derive `modelsUsed`
  // in JS without a separate `SELECT DISTINCT model` round-trip.
  const turns = db
    .prepare(
      `SELECT turn_index, ts, role, model, is_error, text_preview, output_tokens
       FROM turns
       WHERE session_id = ?
       ORDER BY turn_index`
    )
    .all(sessionId) as TurnRow[];

  const tools = db
    .prepare(
      `SELECT turn_index, sequence_in_turn, tool_use_id, ts, tool_name,
              agent_name, skill_name, arguments_json, file_path, file_op
       FROM tool_uses
       WHERE session_id = ?
       ORDER BY turn_index, sequence_in_turn`
    )
    .all(sessionId) as ToolRow[];

  const aggregates = aggregateTools(tools);
  const timeline = buildTimeline(turns, aggregates.toolsByTurn);
  const modelsUsed = collectModelsUsed(turns);

  // isActive matches the file-parse heuristic: file mtime within 2 min.
  const isActive = Date.now() - session.file_mtime_ms < 2 * 60_000;
  // status heuristic — see header comment. Detail view uses isActive.
  const status: SessionStatus = isActive ? "working" : "idle";
  const durationMs =
    session.start_ts && session.end_ts
      ? new Date(session.end_ts).getTime() - new Date(session.start_ts).getTime()
      : undefined;

  const oneShotRate =
    session.verified_task_count > 0
      ? session.one_shot_task_count / session.verified_task_count
      : undefined;

  // `lastPrompt` is suppressed when identical to the initial prompt —
  // matches the file-parse path so single-prompt sessions don't render
  // "First prompt" and "Last prompt" with the same text.
  const lastPrompt =
    session.last_prompt && session.last_prompt !== session.initial_prompt
      ? session.last_prompt
      : undefined;

  return {
    sessionId: session.session_id,
    projectPath: decodeDirName(session.project_dir_name),
    projectSlug: session.project_slug ?? "",
    projectName: session.project_dir_name,
    startTime: session.start_ts ?? undefined,
    endTime: session.end_ts ?? undefined,
    durationMs,
    initialPrompt: session.initial_prompt ?? undefined,
    lastPrompt,
    recaps: undefined,
    messageCount: session.turn_count,
    userMessageCount: session.user_turn_count,
    assistantMessageCount: session.assistant_turn_count,
    inputTokens: session.input_tokens,
    outputTokens: session.output_tokens,
    cacheReadTokens: session.cache_read_tokens,
    cacheCreateTokens: session.cache_create_tokens,
    costEstimate: session.cost_usd,
    toolUsage: aggregates.toolUsage,
    modelsUsed,
    gitBranch: session.git_branch ?? undefined,
    subagentCount: aggregates.subagents.length,
    errorCount: session.error_count,
    isActive,
    status,
    skillsUsed: aggregates.skillsUsed,
    oneShotRate,
    searchableText: undefined,
    timeline,
    fileOperations: aggregates.fileOperations,
    subagents: aggregates.subagents,
  };
}

// ── Timeline ──────────────────────────────────────────────────────────────

function buildTimeline(turns: TurnRow[], toolsByTurn: Map<number, ToolRow[]>): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      // file-parse skips the user turn unless it had a non-empty human
      // text; we mirror by skipping turns whose text_preview is null
      // (tool-result-only user turns).
      if (turn.text_preview) {
        events.push({
          type: "user",
          timestamp: turn.ts,
          content: turn.text_preview,
        });
      }
      continue;
    }
    // assistant
    if (turn.is_error === 1) {
      events.push({
        type: "error",
        timestamp: turn.ts,
        content: turn.text_preview ?? "API error",
      });
      continue;
    }
    if (turn.text_preview) {
      events.push({
        type: "assistant",
        timestamp: turn.ts,
        content: turn.text_preview.slice(0, TIMELINE_TEXT_LIMIT),
        tokenCount: turn.output_tokens > 0 ? turn.output_tokens : undefined,
      });
    }
    const toolList = toolsByTurn.get(turn.turn_index);
    if (!toolList) continue;
    for (const tu of toolList) {
      events.push({
        type: "tool_use",
        timestamp: tu.ts ?? turn.ts,
        content: summarizeTool(tu),
        toolName: tu.tool_name,
      });
    }
  }
  return events;
}

/**
 * Summary text for a tool_use timeline event, matching the file-parse
 * path's logic in `scanSessionDetail` (file_path, command, pattern,
 * prompt, description — first match wins).
 */
function summarizeTool(tu: ToolRow): string {
  const args = parseStoredArgs(tu.arguments_json) ?? {};
  if (typeof args.file_path === "string") {
    return `${tu.tool_name}: ${args.file_path}`;
  }
  if (typeof args.command === "string") {
    return `${tu.tool_name}: ${String(args.command).slice(0, 100)}`;
  }
  if (typeof args.pattern === "string") {
    return `${tu.tool_name}: ${args.pattern}`;
  }
  if (typeof args.prompt === "string") {
    return `${tu.tool_name}: ${String(args.prompt).slice(0, 100)}`;
  }
  if (typeof args.description === "string") {
    return `${tu.tool_name}: ${String(args.description).slice(0, 100)}`;
  }
  return tu.tool_name;
}

// ── Tool aggregations (single pass) ───────────────────────────────────────

interface ToolAggregates {
  toolsByTurn: Map<number, ToolRow[]>;
  toolUsage: Record<string, number>;
  skillsUsed: Record<string, number>;
  subagents: SubagentInfo[];
  fileOperations: FileOperation[];
}

/**
 * Single-pass projection of `tool_uses` into every aggregate the
 * detail view needs. Replaces four separate iterations with one. Also
 * deduplicates `parseStoredArgs` work — Bash and Agent rows that
 * previously had their JSON re-parsed in multiple helpers parse it
 * once here.
 *
 * For `fileOperations`: we deliberately go through `tool_uses` rather
 * than `file_edits`. `file_edits` dedupes to one row per
 * (session, turn, file) for hot-file analytics, but the file-parse
 * path emits one entry per tool_use (no dedup). Three categories:
 *   1. Tools with `file_op` set (Read/Write/Edit/MultiEdit/NotebookEdit) —
 *      `file_op` is the canonical operation.
 *   2. Tools with `file_path` set but no `file_op` (e.g., Glob/Grep
 *      with `file_path` argument) — operation = lowercased tool_name.
 *      This contract works because the file-parse path's
 *      `FILE_TOOL_OPERATIONS` map happens to use lowercase keys; if
 *      that ever changes, both paths must move together.
 *   3. `Bash` calls (no file_path) — synthesize
 *      `{path: command.slice(0,100), operation: "bash"}` from
 *      `arguments_json`.
 */
function aggregateTools(tools: ToolRow[]): ToolAggregates {
  const toolsByTurn = new Map<number, ToolRow[]>();
  const toolUsage: Record<string, number> = {};
  const skillsUsed: Record<string, number> = {};
  const subagents: SubagentInfo[] = [];
  const fileOperations: FileOperation[] = [];

  for (const tu of tools) {
    // Group for timeline assembly.
    const list = toolsByTurn.get(tu.turn_index);
    if (list) list.push(tu);
    else toolsByTurn.set(tu.turn_index, [tu]);

    // Per-tool count.
    toolUsage[tu.tool_name] = (toolUsage[tu.tool_name] ?? 0) + 1;

    // Skills: read straight from the indexed `skill_name` column —
    // no JSON parse. Ingest already extracted it from the args at
    // write time.
    if (tu.tool_name === "Skill" && tu.skill_name) {
      skillsUsed[tu.skill_name] = (skillsUsed[tu.skill_name] ?? 0) + 1;
    }

    // File ops — see header comment for the three categories.
    if (tu.file_path) {
      fileOperations.push({
        path: tu.file_path,
        operation: tu.file_op ?? tu.tool_name.toLowerCase(),
        timestamp: tu.ts ?? undefined,
        toolName: tu.tool_name,
      });
    } else if (tu.tool_name === "Bash") {
      const args = parseStoredArgs(tu.arguments_json) ?? {};
      if (typeof args.command === "string") {
        fileOperations.push({
          path: String(args.command).slice(0, 100),
          operation: "bash",
          timestamp: tu.ts ?? undefined,
          toolName: "Bash",
        });
      }
    }

    // Subagents — `messageCount` and `toolUsage` stay zero/empty
    // (sidechain entries aren't indexed; documented divergence).
    if (tu.tool_name === "Agent") {
      const args = parseStoredArgs(tu.arguments_json) ?? {};
      const description =
        typeof args.description === "string"
          ? args.description.slice(0, 200)
          : typeof args.prompt === "string"
            ? String(args.prompt).slice(0, 200)
            : "";
      subagents.push({
        agentId: tu.tool_use_id ?? `tu_${tu.turn_index}_${tu.sequence_in_turn}`,
        type: tu.agent_name ?? "general-purpose",
        description,
        messageCount: 0,
        toolUsage: {},
      });
    }
  }

  return { toolsByTurn, toolUsage, skillsUsed, subagents, fileOperations };
}

/**
 * Distinct non-synthetic assistant models used in the session,
 * derived from the already-loaded `turns` rows. Saves a round-trip
 * vs `SELECT DISTINCT model FROM turns WHERE session_id = ?`.
 */
function collectModelsUsed(turns: TurnRow[]): string[] {
  const set = new Set<string>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    if (!t.model || t.model === "<synthetic>") continue;
    set.add(t.model);
  }
  return Array.from(set);
}
