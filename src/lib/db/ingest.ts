import "server-only";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";
import { canonicalizeDirName } from "@/lib/usage/parser";
import { toSlug, type ConversationEntry } from "@/lib/scanner/claudeConversations";
import { classifyTurn } from "@/lib/usage/classifier";
import { detectOneShot } from "@/lib/usage/oneShotDetector";
import { loadPricing, getModelPricing } from "@/lib/usage/costCalculator";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";
import { DERIVED_VERSION } from "./derivationVersion";

// Session ingest pipeline.
//
// Reads `~/.claude/projects/**/*.jsonl`, normalizes each session into rows
// in `sessions` / `turns` / `tool_uses` / `file_edits`, computes derived
// metrics (cost, category, one-shot flag, cache hit ratio), and refreshes
// the `daily_costs` rollup for any (day, project, model) tuple touched by
// the reconcile.
//
// Design tenets:
//
// * **One transaction per session.** All inserts for a single JSONL file
//   are wrapped in a single `db.transaction(...)` so a half-failed parse
//   leaves zero rows (FK cascades from `sessions` clean up children).
//
// * **mtime+size + derived_version no-op gate.** A session whose file
//   mtime/size are unchanged AND whose `derived_version` matches the
//   current code's stamp is skipped entirely. This is the primary speed
//   win — repeat reconciles touch only changed/stale rows.
//
// * **Reuse the file-parse path's logic.** `classifyTurn`,
//   `detectOneShot`, and `getModelPricing` ingest into the DB so a future
//   read-side switch (P2b) is just "same numbers, faster query."
//
// * **No watcher, no worker_thread yet.** This module is callable
//   directly. The watcher (P2a-2.2) and worker wrap (P2a-2.4) come in
//   later slices. Tests call these functions directly.

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const TEXT_PREVIEW_LIMIT = 500;
const ARGS_JSON_LIMIT = 10_000;

interface IngestStats {
  filesSeen: number;
  filesChanged: number;
  rowsWritten: number;
  errors: number;
}

interface ParsedToolUse {
  sequenceInTurn: number;
  toolUseId: string | null;
  toolName: string;
  mcpServer: string | null;
  mcpTool: string | null;
  agentName: string | null;
  skillName: string | null;
  argumentsJson: string | null;
  filePath: string | null;
  fileOp: "read" | "write" | "edit" | "delete" | null;
  isError: 0 | 1;
}

interface ParsedTurn {
  turnIndex: number;
  ts: string;
  role: "user" | "assistant";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  isError: 0 | 1;
  parentToolUseId: string | null;
  textPreview: string | null;
  toolUses: ParsedToolUse[];
  // UsageTurn-shaped projection for classifier/one-shot reuse.
  usageTurn: UsageTurn;
}

interface ParsedSession {
  sessionId: string;
  projectDirName: string;
  projectSlug: string;
  filePath: string;
  fileMtimeMs: number;
  fileSize: number;
  startTs: string | null;
  endTs: string | null;
  primaryModel: string | null;
  gitBranch: string | null;
  initialPrompt: string | null;
  lastPrompt: string | null;
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  toolCallCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  cacheHitRatio: number | null;
  hasOneShot: 0 | 1;
  turns: ParsedTurn[];
  // (day, project, model) tuples to recompute in daily_costs after this
  // session is replaced.
  affectedDays: Set<string>;
}

// ── Tool-call classification helpers ───────────────────────────────────────

/**
 * Detect MCP tools by Claude Code's `mcp__<server>__<tool>` naming convention.
 * Returns server/tool names or null/null for non-MCP tools.
 */
function parseMcpToolName(toolName: string): { server: string | null; tool: string | null } {
  if (!toolName.startsWith("mcp__")) return { server: null, tool: null };
  // Format: mcp__<server>__<tool>. Server and tool may themselves contain
  // underscores, so split on the *first* `__` after the prefix and treat
  // the rest as the tool name.
  const rest = toolName.slice(5);
  const sep = rest.indexOf("__");
  if (sep === -1) return { server: rest, tool: null };
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * Map a tool call to a (file_path, file_op) pair if it's a write/edit-shaped
 * operation. Returns null/null for non-file tools or when the path is missing.
 */
function extractFileOp(
  toolName: string,
  args: Record<string, unknown> | undefined
): { filePath: string | null; fileOp: ParsedToolUse["fileOp"] } {
  if (!args) return { filePath: null, fileOp: null };
  const fp = typeof args.file_path === "string" ? args.file_path : null;
  if (!fp) return { filePath: null, fileOp: null };
  if (toolName === "Write") return { filePath: fp, fileOp: "write" };
  if (toolName === "Edit" || toolName === "MultiEdit") return { filePath: fp, fileOp: "edit" };
  if (toolName === "Read") return { filePath: fp, fileOp: "read" };
  return { filePath: fp, fileOp: null };
}

/**
 * If this is a Task tool call, the subagent name is on `arguments.subagent_type`.
 * Other agent dispatchers may surface here too — keep central so we can extend.
 */
function extractAgentName(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName !== "Task" || !args) return null;
  return typeof args.subagent_type === "string" ? args.subagent_type : null;
}

// ── JSONL → ParsedSession ──────────────────────────────────────────────────

function truncateText(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function extractTurnText(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function extractToolResultText(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "tool_result")
    .map((b: any) => {
      if (typeof b.content === "string") return b.content;
      if (Array.isArray(b.content)) {
        return b.content
          .filter((c: any) => c.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n");
      }
      return "";
    })
    .join("\n");
}

async function readJsonlSession(
  filePath: string,
  projectDirName: string,
  fileMtimeMs: number,
  fileSize: number
): Promise<ParsedSession | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const turns: ParsedTurn[] = [];
  let startTs: string | null = null;
  let endTs: string | null = null;
  let gitBranch: string | null = null;
  let initialPrompt: string | null = null;
  let lastPrompt: string | null = null;
  const modelCounts = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let userTurnCount = 0;
  let assistantTurnCount = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ConversationEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.isSidechain || entry.isMeta || !entry.timestamp) continue;
    const { type, timestamp } = entry;
    if (type !== "assistant" && type !== "user") continue;

    if (!startTs) startTs = timestamp;
    endTs = timestamp;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;

    const turnIndex = turns.length;

    if (type === "assistant") {
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);

      const usage = entry.message?.usage ?? {};
      const ti = usage.input_tokens ?? 0;
      const to = usage.output_tokens ?? 0;
      const tcc = usage.cache_creation_input_tokens ?? 0;
      const tcr = usage.cache_read_input_tokens ?? 0;
      inputTokens += ti;
      outputTokens += to;
      cacheCreateTokens += tcc;
      cacheReadTokens += tcr;

      const isError = entry.isApiErrorMessage === true ? 1 : 0;
      if (isError) errorCount++;
      assistantTurnCount++;

      const content = entry.message?.content ?? [];
      const text = extractTurnText(content);
      const textPreview = truncateText(text, TEXT_PREVIEW_LIMIT);

      const toolBlocks = Array.isArray(content)
        ? content.filter((b: any) => b.type === "tool_use")
        : [];

      const toolUses: ParsedToolUse[] = toolBlocks.map((b: any, idx: number) => {
        const args = (b.input ?? {}) as Record<string, unknown>;
        const { server, tool } = parseMcpToolName(b.name ?? "");
        const { filePath: fp, fileOp } = extractFileOp(b.name ?? "", args);
        let argsJson: string | null = null;
        try {
          argsJson = truncateText(JSON.stringify(args), ARGS_JSON_LIMIT);
        } catch {
          argsJson = null;
        }
        return {
          sequenceInTurn: idx,
          toolUseId: typeof b.id === "string" ? b.id : null,
          toolName: typeof b.name === "string" ? b.name : "unknown",
          mcpServer: server,
          mcpTool: tool,
          agentName: extractAgentName(b.name ?? "", args),
          skillName: null,
          argumentsJson: argsJson,
          filePath: fp,
          fileOp,
          isError: 0,
        };
      });
      toolCallCount += toolUses.length;

      const usageTurn: UsageTurn = {
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model,
        role: "assistant",
        inputTokens: ti,
        outputTokens: to,
        cacheCreateTokens: tcc,
        cacheReadTokens: tcr,
        toolCalls: toolBlocks.map(
          (b: any): ToolCall => ({ name: b.name, arguments: b.input })
        ),
        isError: !!isError,
      };

      turns.push({
        turnIndex,
        ts: timestamp,
        role: "assistant",
        model,
        inputTokens: ti,
        outputTokens: to,
        cacheCreateTokens: tcc,
        cacheReadTokens: tcr,
        isError,
        parentToolUseId: null,
        textPreview,
        toolUses,
        usageTurn,
      });
    } else {
      // user turn
      userTurnCount++;
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = (entry.content ?? []) as any[];
      const textSource = messageContent.length > 0 ? messageContent : topLevelContent;
      const userText = extractTurnText(textSource);
      const toolResultText = extractToolResultText(textSource);
      const previewSource = userText || toolResultText;
      const textPreview = truncateText(previewSource, TEXT_PREVIEW_LIMIT);
      // Track first/last *human* prompt — exclude tool-result-only turns.
      // Hook-injected prompts (text starting with `<`) are also excluded;
      // they're system noise rather than the user's intent.
      const looksHuman = userText && !userText.trim().startsWith("<");
      if (looksHuman) {
        if (!initialPrompt) initialPrompt = textPreview;
        lastPrompt = textPreview;
      }

      const usageTurn: UsageTurn = {
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model: "",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText: userText || undefined,
        toolResultText: toolResultText || undefined,
      };

      turns.push({
        turnIndex,
        ts: timestamp,
        role: "user",
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        isError: 0,
        parentToolUseId: null,
        textPreview,
        toolUses: [],
        usageTurn,
      });
    }
  }

  if (turns.length === 0) return null;

  // Derive: primary model = most-frequent assistant model.
  let primaryModel: string | null = null;
  let bestCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > bestCount) {
      primaryModel = model;
      bestCount = count;
    }
  }

  // Derive: cost (sum per-turn) and category (per assistant turn).
  let costUsd = 0;
  for (const t of turns) {
    if (t.role !== "assistant" || !t.model) continue;
    const pricing = getModelPricing(t.model);
    costUsd +=
      t.inputTokens * pricing.inputCostPerToken +
      t.outputTokens * pricing.outputCostPerToken +
      t.cacheCreateTokens * pricing.cacheWriteCostPerToken +
      t.cacheReadTokens * pricing.cacheReadCostPerToken;
  }

  // Derive: one-shot detection across the whole session.
  const allUsageTurns = turns.map((t) => t.usageTurn);
  const oneShot = detectOneShot(allUsageTurns);
  const hasOneShot: 0 | 1 = oneShot.oneShotTasks > 0 ? 1 : 0;

  // Derive: cache hit ratio. Undefined when there's no cache activity at all.
  const cacheTotal = cacheCreateTokens + cacheReadTokens;
  const cacheHitRatio = cacheTotal > 0 ? cacheReadTokens / cacheTotal : null;

  // Derive: affected (day, project, model) tuples for daily_costs.
  const affectedDays = new Set<string>();
  for (const t of turns) {
    if (t.role !== "assistant" || !t.model) continue;
    const day = t.ts.slice(0, 10); // YYYY-MM-DD
    affectedDays.add(`${day}|${projectSlug}|${t.model}`);
  }

  return {
    sessionId,
    projectDirName: canonicalDir,
    projectSlug,
    filePath,
    fileMtimeMs,
    fileSize,
    startTs,
    endTs,
    primaryModel,
    gitBranch,
    initialPrompt,
    lastPrompt,
    turnCount: turns.length,
    userTurnCount,
    assistantTurnCount,
    toolCallCount,
    errorCount,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    costUsd,
    cacheHitRatio,
    hasOneShot,
    turns,
    affectedDays,
  };
}

// ── DB writers ─────────────────────────────────────────────────────────────

/**
 * Write one parsed session. Caller wraps in a transaction. On a re-parse of
 * an existing session, we DELETE the old session row first (cascading FK
 * deletes wipe children) then INSERT fresh — simpler and more correct than
 * trying to UPDATE-or-INSERT individual children.
 */
function writeSession(db: DatabaseT.Database, s: ParsedSession): number {
  let rows = 0;

  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(s.sessionId);

  db.prepare(
    `INSERT INTO sessions (
       session_id, project_slug, project_dir_name, file_path,
       file_mtime_ms, file_size, byte_offset,
       start_ts, end_ts, primary_model,
       turn_count, user_turn_count, assistant_turn_count,
       tool_call_count, error_count,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       cost_usd, cache_hit_ratio,
       has_one_shot,
       git_branch, initial_prompt, last_prompt,
       derived_version, indexed_at_ms
     ) VALUES (
       @session_id, @project_slug, @project_dir_name, @file_path,
       @file_mtime_ms, @file_size, @byte_offset,
       @start_ts, @end_ts, @primary_model,
       @turn_count, @user_turn_count, @assistant_turn_count,
       @tool_call_count, @error_count,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @cost_usd, @cache_hit_ratio,
       @has_one_shot,
       @git_branch, @initial_prompt, @last_prompt,
       @derived_version, @indexed_at_ms
     )`
  ).run({
    session_id: s.sessionId,
    project_slug: s.projectSlug,
    project_dir_name: s.projectDirName,
    file_path: s.filePath,
    file_mtime_ms: s.fileMtimeMs,
    file_size: s.fileSize,
    byte_offset: s.fileSize, // P2a-2.1: cursor = whole file. Real tail comes in 2.3.
    start_ts: s.startTs,
    end_ts: s.endTs,
    primary_model: s.primaryModel,
    turn_count: s.turnCount,
    user_turn_count: s.userTurnCount,
    assistant_turn_count: s.assistantTurnCount,
    tool_call_count: s.toolCallCount,
    error_count: s.errorCount,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    cache_create_tokens: s.cacheCreateTokens,
    cache_read_tokens: s.cacheReadTokens,
    cost_usd: s.costUsd,
    cache_hit_ratio: s.cacheHitRatio,
    has_one_shot: s.hasOneShot,
    git_branch: s.gitBranch,
    initial_prompt: s.initialPrompt,
    last_prompt: s.lastPrompt,
    derived_version: DERIVED_VERSION,
    indexed_at_ms: Date.now(),
  });
  rows++;

  const insertTurn = db.prepare(
    `INSERT INTO turns (
       session_id, turn_index, ts, role, model,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       is_error, parent_tool_use_id, text_preview, category, derived_version
     ) VALUES (
       @session_id, @turn_index, @ts, @role, @model,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @is_error, @parent_tool_use_id, @text_preview, @category, @derived_version
     )`
  );
  const insertToolUse = db.prepare(
    `INSERT INTO tool_uses (
       session_id, turn_index, sequence_in_turn, tool_use_id, ts, tool_name,
       mcp_server, mcp_tool, agent_name, skill_name,
       arguments_json, file_path, file_op, is_error
     ) VALUES (
       @session_id, @turn_index, @sequence_in_turn, @tool_use_id, @ts, @tool_name,
       @mcp_server, @mcp_tool, @agent_name, @skill_name,
       @arguments_json, @file_path, @file_op, @is_error
     )`
  );
  const insertFileEdit = db.prepare(
    `INSERT OR IGNORE INTO file_edits (session_id, turn_index, file_path, op, ts)
     VALUES (?, ?, ?, ?, ?)`
  );

  for (const t of s.turns) {
    const category = t.role === "assistant" ? classifyTurn(t.usageTurn) : null;
    insertTurn.run({
      session_id: s.sessionId,
      turn_index: t.turnIndex,
      ts: t.ts,
      role: t.role,
      model: t.model,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_create_tokens: t.cacheCreateTokens,
      cache_read_tokens: t.cacheReadTokens,
      is_error: t.isError,
      parent_tool_use_id: t.parentToolUseId,
      text_preview: t.textPreview,
      category,
      derived_version: DERIVED_VERSION,
    });
    rows++;

    for (const tu of t.toolUses) {
      insertToolUse.run({
        session_id: s.sessionId,
        turn_index: t.turnIndex,
        sequence_in_turn: tu.sequenceInTurn,
        tool_use_id: tu.toolUseId,
        ts: t.ts,
        tool_name: tu.toolName,
        mcp_server: tu.mcpServer,
        mcp_tool: tu.mcpTool,
        agent_name: tu.agentName,
        skill_name: tu.skillName,
        arguments_json: tu.argumentsJson,
        file_path: tu.filePath,
        file_op: tu.fileOp,
        is_error: tu.isError,
      });
      rows++;

      if (tu.fileOp && tu.filePath && tu.fileOp !== "read") {
        insertFileEdit.run(s.sessionId, t.turnIndex, tu.filePath, tu.fileOp, t.ts);
        rows++;
      }
    }
  }

  return rows;
}

/**
 * Recompute `daily_costs` rows for a set of (day, project_slug, model)
 * tuples. We always recompute the full tuple from `turns` rather than
 * try to apply an incremental delta — easy to get wrong when sessions
 * are replaced wholesale.
 */
function refreshDailyCosts(db: DatabaseT.Database, tuples: Set<string>): void {
  if (tuples.size === 0) return;
  const deleteStmt = db.prepare(
    "DELETE FROM daily_costs WHERE day = ? AND project_slug = ? AND model = ?"
  );
  const insertStmt = db.prepare(
    `INSERT INTO daily_costs (
       day, project_slug, model,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       cost_usd, turn_count, session_count
     )
     SELECT
       substr(t.ts, 1, 10)        AS day,
       s.project_slug             AS project_slug,
       t.model                    AS model,
       SUM(t.input_tokens)        AS input_tokens,
       SUM(t.output_tokens)       AS output_tokens,
       SUM(t.cache_create_tokens) AS cache_create_tokens,
       SUM(t.cache_read_tokens)   AS cache_read_tokens,
       0                          AS cost_usd,
       COUNT(*)                   AS turn_count,
       COUNT(DISTINCT t.session_id) AS session_count
     FROM turns t
     JOIN sessions s USING (session_id)
     WHERE t.role = 'assistant'
       AND t.model = ?
       AND s.project_slug = ?
       AND substr(t.ts, 1, 10) = ?
     GROUP BY day, s.project_slug, t.model`
  );
  // Cost can't be summed in pure SQL because pricing is held in JS. Compute
  // it after the row exists, using the same per-turn formula as session-level
  // cost. This is one extra small query per affected tuple; tuple cardinality
  // is bounded by (active days × active projects × active models).
  const fetchTurnsStmt = db.prepare(
    `SELECT t.input_tokens, t.output_tokens, t.cache_create_tokens, t.cache_read_tokens
     FROM turns t
     JOIN sessions s USING (session_id)
     WHERE t.role = 'assistant'
       AND t.model = ?
       AND s.project_slug = ?
       AND substr(t.ts, 1, 10) = ?`
  );
  const updateCostStmt = db.prepare(
    "UPDATE daily_costs SET cost_usd = ? WHERE day = ? AND project_slug = ? AND model = ?"
  );

  for (const tuple of tuples) {
    const [day, projectSlug, model] = tuple.split("|");
    deleteStmt.run(day, projectSlug, model);
    insertStmt.run(model, projectSlug, day);
    const pricing = getModelPricing(model);
    let cost = 0;
    const rows = fetchTurnsStmt.all(model, projectSlug, day) as Array<{
      input_tokens: number;
      output_tokens: number;
      cache_create_tokens: number;
      cache_read_tokens: number;
    }>;
    for (const r of rows) {
      cost +=
        r.input_tokens * pricing.inputCostPerToken +
        r.output_tokens * pricing.outputCostPerToken +
        r.cache_create_tokens * pricing.cacheWriteCostPerToken +
        r.cache_read_tokens * pricing.cacheReadCostPerToken;
    }
    if (rows.length > 0) {
      updateCostStmt.run(cost, day, projectSlug, model);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Override the projects root for tests. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** Force re-parse of every session, ignoring the mtime/size + version gate. */
  force?: boolean;
}

/**
 * Reconcile a single JSONL file into the DB. Returns row count written, or
 * 0 if the file was skipped via the no-op gate. Caller is responsible for
 * `loadPricing()` having completed first.
 */
export async function reconcileSessionFile(
  db: DatabaseT.Database,
  filePath: string,
  projectDirName: string,
  options: { force?: boolean } = {}
): Promise<number> {
  let stat: { mtimeMs: number; size: number };
  try {
    const s = await fs.stat(filePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return 0;
  }
  // A session previously ingested at <50 MB that has since grown past the
  // limit will keep its stale row — we return 0 here without re-parsing or
  // pruning. The file-parse path has the same behavior. P2a-2.3's byte_offset
  // tail will let us amend the row incrementally and remove the cap.
  if (stat.size > MAX_SESSION_FILE_SIZE) return 0;

  const sessionId = path.basename(filePath, ".jsonl");
  if (!options.force) {
    const existing = db
      .prepare(
        "SELECT file_mtime_ms, file_size, derived_version FROM sessions WHERE session_id = ?"
      )
      .get(sessionId) as
      | { file_mtime_ms: number; file_size: number; derived_version: number }
      | undefined;
    if (
      existing &&
      existing.file_mtime_ms === Math.floor(stat.mtimeMs) &&
      existing.file_size === stat.size &&
      existing.derived_version === DERIVED_VERSION
    ) {
      return 0;
    }
  }

  const parsed = await readJsonlSession(
    filePath,
    projectDirName,
    Math.floor(stat.mtimeMs),
    stat.size
  );
  if (!parsed) return 0;

  let rows = 0;
  const txn = db.transaction(() => {
    rows = writeSession(db, parsed);
  });
  txn();
  refreshDailyCosts(db, parsed.affectedDays);
  return rows;
}

/**
 * Walk `~/.claude/projects/**\/*.jsonl`, reconcile each session, and prune
 * sessions whose source file is gone. Idempotent — repeat calls hit the
 * mtime/size + derived_version gate and do nothing.
 *
 * Tests call this directly. The watcher (P2a-2.2) will call this for the
 * initial reconcile then react to chokidar events for incremental work.
 */
export async function reconcileAllSessions(
  db: DatabaseT.Database,
  options: ReconcileOptions = {}
): Promise<IngestStats> {
  const stats: IngestStats = { filesSeen: 0, filesChanged: 0, rowsWritten: 0, errors: 0 };
  const projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");

  await loadPricing();

  let subdirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return stats;
  }

  const liveFilePaths = new Set<string>();

  // Sequential per-file because all writes go through the single writer
  // connection. Parallelism would just queue on the busy_timeout. The
  // worker_thread wrap (P2a-2.4) is where we'd consider a producer/consumer
  // split if ingest throughput becomes a bottleneck.
  for (const dirName of subdirs) {
    const dirPath = path.join(projectsDir, dirName);
    let files: string[];
    try {
      const entries = await fs.readdir(dirPath);
      files = entries.filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      liveFilePaths.add(filePath);
      stats.filesSeen++;
      try {
        const written = await reconcileSessionFile(db, filePath, dirName, options);
        if (written > 0) {
          stats.filesChanged++;
          stats.rowsWritten += written;
        }
      } catch {
        stats.errors++;
      }
    }
  }

  // Prune sessions whose JSONL file vanished. One SELECT pulls the full
  // (session_id, project_slug, file_path) tuple — no per-row lookup. Cascade
  // FK deletes clean turns / tool_uses / file_edits.
  const allSessions = db
    .prepare("SELECT session_id, project_slug, file_path FROM sessions")
    .all() as Array<{ session_id: string; project_slug: string; file_path: string }>;
  const deleteStale = db.prepare("DELETE FROM sessions WHERE session_id = ?");
  const stalePruned = new Set<string>();
  for (const r of allSessions) {
    if (!liveFilePaths.has(r.file_path)) {
      deleteStale.run(r.session_id);
      stalePruned.add(r.project_slug);
    }
  }

  // Pruned sessions removed cost contributions on their days — do a coarse
  // refresh by collecting every (day, project, model) tuple still present
  // for the affected projects. Cheap because we only refresh tuples that
  // actually exist in `turns`.
  if (stalePruned.size > 0) {
    const tuples = new Set<string>();
    const ph = Array.from(stalePruned).map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.model AS model
         FROM turns t JOIN sessions s USING (session_id)
         WHERE t.role = 'assistant' AND t.model IS NOT NULL
           AND s.project_slug IN (${ph})`
      )
      .all(...Array.from(stalePruned)) as Array<{ day: string; project_slug: string; model: string }>;
    for (const r of rows) tuples.add(`${r.day}|${r.project_slug}|${r.model}`);
    // Also delete daily_costs rows whose project_slug is in the pruned set
    // but whose tuple is no longer in `turns` (the project may have lost
    // its only session for a given day).
    for (const slug of stalePruned) {
      db.prepare("DELETE FROM daily_costs WHERE project_slug = ?").run(slug);
    }
    refreshDailyCosts(db, tuples);
  }

  return stats;
}
