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
// tables instead of re-parsing the JSONL on every detail view. The cold
// path turns from "stat + read 50MB JSONL + parse" into "3 small SELECTs
// against indexed columns" — one each for `sessions`, `turns`, and
// `tool_uses`. `modelsUsed` is derived from the already-loaded `turns`
// rows (no separate `SELECT DISTINCT model` round-trip).
//
// **Documented divergences from the file-parse path** — these are
// intentional because the underlying data isn't in the index, and
// closing them would require schema/ingest changes:
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
//    'bash', so we don't write them there — the read query reads
//    everything from `tool_uses` for parity with file-parse's
//    per-tool-use emission semantics.
// 6. **No `thinking` events in `timeline`**: file-parse emits a
//    `thinking` event for each `block.type === "thinking"` block on an
//    assistant message. Ingest doesn't persist content blocks, so the
//    DB path can't reconstruct them. Same applies to the
//    "one-`assistant`-event-per-text-block" semantic — file-parse emits
//    N events for an assistant turn with N text blocks (interleaved
//    with tool_use events in original order); the DB path emits at
//    most one `assistant` event per turn followed by a flat run of
//    `tool_use` events, because `text_preview` collapses all text
//    blocks into a single 500-char prefix. Sessions with multi-block
//    assistant content or thinking will therefore have shorter
//    timelines and a different event-type sequence under MINDER_USE_DB.
// 7. **Sidechain entries skipped at ingest**: `scanSessionFile` counts
//    sidechain assistant entries toward `messageCount`, token totals,
//    `toolUsage`, `modelsUsed`, and `costEstimate`. The DB indexer
//    drops `entry.isSidechain` rows, so SessionSummary aggregates can
//    be lower in the DB path for sessions that dispatched subagents.
// 8. **`fileOperations` only emits for the file-parse tool set**:
//    Read/Write/Edit/Glob/Grep + Bash. MultiEdit/NotebookEdit (which
//    are persisted to `file_edits` for hot-file analytics) are
//    deliberately filtered out here so DB and file-parse agree.
//
// SessionSummary fields derived from indexed non-sidechain rows match
// the file-parse path within the bounds of (3) and (7) above. The
// timeline content matches for sessions with single-text-block
// assistant turns and no `thinking` blocks (the common case in the
// test fixture).

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
  tool_result_preview: string | null;
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

// Match file-parse's slice lengths: assistant text capped at 300
// (`scanSessionDetail`'s per-block slice), user text capped at 200
// (`extractTextContent`'s slice in the file-parse path).
const TIMELINE_TEXT_LIMIT = 300;
const USER_TIMELINE_TEXT_LIMIT = 200;

// File operations parity gate: file-parse emits entries only for these
// tools (FILE_TOOL_OPERATIONS in `scanSessionDetail`) plus `Bash`.
// MultiEdit/NotebookEdit are persisted to `file_edits` for hot-file
// analytics but deliberately excluded here so the two backends agree.
const FILE_OP_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

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
  // `tool_result_preview` lets us detect tool-result-only user turns
  // (file-parse skips them; see `buildTimeline`).
  const turns = db
    .prepare(
      `SELECT turn_index, ts, role, model, is_error,
              text_preview, tool_result_preview, output_tokens
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
      // file-parse skips user turns whose only content is a tool_result
      // block (`extractTextContent` returns "" → no timeline push). At
      // ingest time, when there's no actual user text, `text_preview`
      // is sourced from the tool_result text and equals the prefix of
      // `tool_result_preview` (text_preview is hard-truncated to 500;
      // tool_result_preview retains up to 2000). Detect that case via
      // `startsWith` rather than `===` so it works for tool results
      // longer than 500 chars.
      if (!turn.text_preview) continue;
      const isToolResultOnly =
        turn.tool_result_preview !== null &&
        turn.tool_result_preview.startsWith(turn.text_preview);
      if (isToolResultOnly) continue;
      events.push({
        type: "user",
        timestamp: turn.ts,
        content: turn.text_preview.slice(0, USER_TIMELINE_TEXT_LIMIT),
      });
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
 * For `fileOperations`: reads from `tool_uses` rather than `file_edits`
 * because the file-parse path emits one entry per tool_use (no dedup),
 * while `file_edits` dedupes to one row per (session, turn, file) for
 * hot-file analytics. Filtered to FILE_OP_TOOLS + Bash to match
 * file-parse's `FILE_TOOL_OPERATIONS` map exactly. MultiEdit and
 * NotebookEdit are deliberately excluded so the two backends agree.
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

    // File ops — restricted to file-parse's tool set for parity. See
    // FILE_OP_TOOLS comment. Operation values match `FILE_TOOL_OPERATIONS`
    // in `scanSessionDetail` (lowercased tool name).
    if (tu.file_path && FILE_OP_TOOLS.has(tu.tool_name)) {
      fileOperations.push({
        path: tu.file_path,
        operation: tu.tool_name.toLowerCase(),
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

    // Subagents — gated on `args.prompt` to mirror file-parse's
    // `if (toolName === "Agent" && input.prompt)` existence test, so
    // an Agent invocation without a prompt doesn't synthesize a
    // subagent row. `messageCount` and `toolUsage` stay zero/empty
    // because sidechain entries aren't indexed (documented divergence).
    if (tu.tool_name === "Agent") {
      const args = parseStoredArgs(tu.arguments_json) ?? {};
      if (typeof args.prompt === "string") {
        const description =
          typeof args.description === "string"
            ? args.description.slice(0, 200)
            : String(args.prompt).slice(0, 200);
        subagents.push({
          agentId: tu.tool_use_id ?? `tu_${tu.turn_index}_${tu.sequence_in_turn}`,
          type: tu.agent_name ?? "general-purpose",
          description,
          messageCount: 0,
          toolUsage: {},
        });
      }
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
