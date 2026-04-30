import "server-only";
import path from "path";
import os from "os";
import { promises as fs, createReadStream } from "fs";
import type DatabaseT from "better-sqlite3";
import { canonicalizeDirName } from "@/lib/usage/parser";
import { toSlug, type ConversationEntry } from "@/lib/scanner/claudeConversations";
import { classifyTurn } from "@/lib/usage/classifier";
import { detectOneShot } from "@/lib/usage/oneShotDetector";
import { loadPricing, getModelPricing, applyPricing } from "@/lib/usage/costCalculator";
import { parseMcpTool } from "@/lib/usage/mcpParser";
import {
  extractText,
  extractToolResults,
  isHumanText,
} from "@/lib/usage/contentBlocks";
import {
  FILE_OP_BY_TOOL,
  AGENT_DISPATCH_TOOL,
  SKILL_DISPATCH_TOOL,
  isFileWriteOp,
  type FileOp,
} from "@/lib/usage/toolNames";
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
// * **No watcher, no `worker_threads` yet.** This module is callable
//   directly. The watcher (P2a-2.2) and worker wrap (P2a-2.4) come in
//   later slices. Tests call these functions directly.

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const TEXT_PREVIEW_LIMIT = 500;
// 32 KB is large enough to hold ~all real-world Bash commands and Edit
// payloads we've seen in user JSONLs. The column is TEXT (no SQLite
// limit); storage cost is bounded by the typical-much-smaller-than-cap
// distribution of args. The previous 10 KB limit was small enough that
// long Edit `old_string` / `new_string` payloads made the JSON invalid
// after slicing, which broke rehydration in `loadExistingTurnsAsUsage`.
const ARGS_JSON_LIMIT = 32_000;
// Parity with the file-parse path (`src/lib/usage/parser.ts`): user text
// is truncated to 500 chars, tool-result text to 2000 chars before the
// downstream classifier / one-shot detector see them. The two paths
// MUST produce identical UsageTurn values or detection verdicts will
// diverge between file-parse and SQLite.
const USAGE_USER_TEXT_LIMIT = 500;
const USAGE_TOOL_RESULT_LIMIT = 2000;

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
  fileOp: FileOp | null;
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
  /**
   * For user turns carrying a tool_result, the truncated result text.
   * Stored separately from `textPreview` so `detectOneShot`'s error-
   * pattern check survives the rehydrate-from-DB round-trip after a
   * tail-append. Null on assistant turns and on user turns that don't
   * have tool_result content.
   */
  toolResultPreview: string | null;
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
  /**
   * Byte position immediately after the last `\n` we consumed. This is
   * the safe cursor — anything beyond it is a partial line that hasn't
   * been flushed yet. Stored as `sessions.byte_offset`, used as the
   * `fromOffset` for the next tail read so a mid-flush race never
   * permanently drops a turn.
   */
  byteOffset: number;
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
 * Map a tool call to a (file_path, file_op) pair when both can be derived.
 * `file_path` is the canonical Claude Code argument key for path-shaped
 * tools — Read, Write, Edit, MultiEdit. Returns null/null for non-file
 * tools or when the path is missing.
 */
function extractFileOp(
  toolName: string,
  args: Record<string, unknown> | undefined
): { filePath: string | null; fileOp: FileOp | null } {
  if (!args) return { filePath: null, fileOp: null };
  const fp = typeof args.file_path === "string" ? args.file_path : null;
  if (!fp) return { filePath: null, fileOp: null };
  return { filePath: fp, fileOp: FILE_OP_BY_TOOL[toolName] ?? null };
}

/** `Agent` tool args carry `subagent_type` per Claude Code's JSONL convention. */
function extractAgentName(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName !== AGENT_DISPATCH_TOOL || !args) return null;
  return typeof args.subagent_type === "string" ? args.subagent_type : null;
}

/** `Skill` tool args carry `skill` per Claude Code's JSONL convention. */
function extractSkillName(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName !== SKILL_DISPATCH_TOOL || !args) return null;
  return typeof args.skill === "string" ? args.skill : null;
}

const COMMAND_RECOVERY_RE = /"command"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/;

/**
 * Parse `tool_uses.arguments_json` from the DB. Tries `JSON.parse` first
 * (the common case); on failure, falls back to a regex match of the
 * `command` field so `detectOneShot` can still see Bash / PowerShell
 * verification commands when the stored JSON was truncated past the
 * boundary of the `command` value.
 *
 * The fallback only recovers `command` because that's the single field
 * the one-shot detector reads. Other detectors that need more fields
 * should prompt a structural fix (separate column or larger limit).
 */
function parseStoredArgs(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    // Capture everything after `"command":"` up to the first non-escaped
    // `"` or end of string. If the truncation cut mid-escape sequence,
    // the JSON.parse below throws and we give up.
    const match = COMMAND_RECOVERY_RE.exec(json);
    if (!match) return undefined;
    try {
      const command = JSON.parse(`"${match[1]}"`);
      return { command };
    } catch {
      return undefined;
    }
  }
}

// ── JSONL → ParsedSession ──────────────────────────────────────────────────

function truncateText(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Read [start, EOF) of a file and return the bytes up to the LAST `\n`
 * along with the byte position immediately after it. Anything after the
 * last newline is treated as a partial line that hasn't been flushed yet
 * and must NOT advance the cursor — otherwise a writer mid-flush could
 * cause us to skip a turn permanently when its first half lands before
 * a reconcile and the second half lands after.
 *
 * Returns `{ text: "", safeOffset: start }` when there's no `\n` in the
 * tail (purely partial content).
 *
 * Backed by `createReadStream({ start })` so the OS only delivers bytes
 * after `start`. The byte-vs-char distinction matters because we can't
 * use `String.lastIndexOf("\n")` here — we need the BYTE position to
 * compute a correct cursor on multi-byte UTF-8 content.
 */
async function readTailToLastNewline(
  filePath: string,
  start: number
): Promise<{ text: string; safeOffset: number }> {
  const stream = createReadStream(filePath, { start });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  // Walk backwards looking for the last 0x0A. lastIndexOf on a Buffer is
  // a single byte scan; cheaper than the BoyerMoore lookup ChainExt'd
  // strings would do.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { text: "", safeOffset: start };
  }
  const text = buf.subarray(0, lastNewline + 1).toString("utf8");
  return { text, safeOffset: start + lastNewline + 1 };
}

interface ReadOptions {
  /** Byte position to start reading from. 0 = full file. */
  fromOffset?: number;
  /** Turn index to assign to the first parsed turn. 0 for full parse. */
  startTurnIndex?: number;
}

/**
 * Parse a session JSONL (full or tail). Returns the parsed session and
 * the safe byte cursor — the position immediately after the last `\n`
 * we consumed. Callers should ALWAYS use the returned `safeOffset` to
 * update `sessions.byte_offset`, even when `parsed` is null (a partial
 * line at EOF means we read 0 turns; the cursor stays where it was so
 * the next reconcile picks up the line once the writer flushes it).
 */
interface ReadResult {
  parsed: ParsedSession | null;
  safeOffset: number;
}

async function readJsonlSession(
  filePath: string,
  projectDirName: string,
  fileMtimeMs: number,
  fileSize: number,
  options: ReadOptions = {}
): Promise<ReadResult | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);
  const fromOffset = options.fromOffset ?? 0;
  const startTurnIndex = options.startTurnIndex ?? 0;

  // Read up to the LAST `\n` and capture the byte position immediately
  // after it as the safe cursor. Both full-parse and tail-parse use the
  // same primitive so the cursor invariant ("position after the last
  // consumed `\n`") holds regardless of whether the writer is mid-flush.
  // If a partial line is appended at EOF, we ingest everything before it
  // and leave the cursor parked at the start of the partial line — the
  // next reconcile picks it up after the writer finishes.
  let raw: string;
  let safeOffset: number;
  try {
    const result = await readTailToLastNewline(filePath, fromOffset);
    raw = result.text;
    safeOffset = result.safeOffset;
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

    const turnIndex = startTurnIndex + turns.length;

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
      // Single pass: extract text and tool_use blocks together rather
      // than filtering the array twice.
      let text = "";
      const toolBlocks: Array<{ id?: string; name?: string; input?: unknown }> = [];
      if (Array.isArray(content)) {
        for (const b of content as any[]) {
          if (b?.type === "text" && typeof b.text === "string") {
            if (text) text += "\n";
            text += b.text;
          } else if (b?.type === "tool_use") {
            toolBlocks.push(b);
          }
        }
      }
      const textPreview = truncateText(text, TEXT_PREVIEW_LIMIT);

      const toolUses: ParsedToolUse[] = toolBlocks.map((b, idx): ParsedToolUse => {
        const args = (b.input ?? {}) as Record<string, unknown>;
        const toolName = typeof b.name === "string" ? b.name : "unknown";
        const mcp = parseMcpTool(toolName);
        const { filePath: fp, fileOp } = extractFileOp(toolName, args);
        let argsJson: string | null = null;
        try {
          argsJson = truncateText(JSON.stringify(args), ARGS_JSON_LIMIT);
        } catch {
          argsJson = null;
        }
        return {
          sequenceInTurn: idx,
          toolUseId: typeof b.id === "string" ? b.id : null,
          toolName,
          mcpServer: mcp?.server ?? null,
          mcpTool: mcp?.tool ?? null,
          agentName: extractAgentName(toolName, args),
          skillName: extractSkillName(toolName, args),
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
        toolResultPreview: null,
        toolUses,
        usageTurn,
      });
    } else {
      // user turn
      userTurnCount++;
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = (entry.content ?? []) as any[];
      const textSource = messageContent.length > 0 ? messageContent : topLevelContent;
      const userText = extractText(textSource).slice(0, USAGE_USER_TEXT_LIMIT);
      const toolResultText = extractToolResults(textSource).slice(0, USAGE_TOOL_RESULT_LIMIT);
      const previewSource = userText || toolResultText;
      const textPreview = truncateText(previewSource, TEXT_PREVIEW_LIMIT);
      // Track first/last *human* prompt — `isHumanText` excludes
      // hook-injected payloads (text starting with `<`) and tool-result
      // -only turns (no `userText`).
      if (isHumanText(userText)) {
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
        toolResultPreview: toolResultText || null,
        toolUses: [],
        usageTurn,
      });
    }
  }

  if (turns.length === 0) return { parsed: null, safeOffset };

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
    costUsd += applyPricing(getModelPricing(t.model), t);
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
    parsed: {
      sessionId,
      projectDirName: canonicalDir,
      projectSlug,
      filePath,
      fileMtimeMs,
      fileSize,
      byteOffset: safeOffset,
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
    },
    safeOffset,
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
    // Cursor invariant: position immediately after the last `\n` we
    // consumed. NOT `s.fileSize` — if the writer is mid-flush, the trailing
    // partial line shouldn't move the cursor past it (that would
    // permanently drop the turn when the line completes).
    byte_offset: s.byteOffset,
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
       is_error, parent_tool_use_id, text_preview, tool_result_preview, category, derived_version
     ) VALUES (
       @session_id, @turn_index, @ts, @role, @model,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @is_error, @parent_tool_use_id, @text_preview, @tool_result_preview, @category, @derived_version
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
      tool_result_preview: t.toolResultPreview,
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

      // INSERT OR IGNORE collapses repeated edits to the same file in the
      // same turn into a single row by design (PK is session_id + turn_index
      // + file_path). Use `.changes` so the rows counter doesn't overcount
      // ignored duplicates.
      if (tu.filePath && isFileWriteOp(tu.fileOp)) {
        const result = insertFileEdit.run(s.sessionId, t.turnIndex, tu.filePath, tu.fileOp, t.ts);
        rows += Number(result.changes);
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
 *
 * Wrapped in a single transaction: if the process crashes mid-refresh,
 * the rollup is either fully old or fully new for this batch, never a
 * partial mix.
 */
export function refreshDailyCosts(db: DatabaseT.Database, tuples: Set<string>): void {
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

  const refreshAllTuples = db.transaction((pendingTuples: Set<string>) => {
    for (const tuple of pendingTuples) {
      refreshOneTuple(tuple);
    }
  });

  function refreshOneTuple(tuple: string): void {
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
      cost += applyPricing(pricing, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreateTokens: r.cache_create_tokens,
        cacheReadTokens: r.cache_read_tokens,
      });
    }
    if (rows.length > 0) {
      updateCostStmt.run(cost, day, projectSlug, model);
    }
  }

  refreshAllTuples(tuples);
}

// ── Tail-append support ────────────────────────────────────────────────────

/**
 * Rehydrate an existing session's turns as `UsageTurn[]` for re-running
 * `detectOneShot` (and any other classifier that needs the full turn
 * history) over old + new combined. The detector looks at sliding
 * windows of turns — Edit → Bash(test) → re-edit — so a tail append can
 * change the verdict on prior turns. We have to feed it the union, not
 * just the new bytes.
 */
function loadExistingTurnsAsUsage(
  db: DatabaseT.Database,
  sessionId: string,
  projectSlug: string,
  projectDirName: string
): UsageTurn[] {
  const turnRows = db
    .prepare(
      `SELECT turn_index, ts, role, model,
              input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
              is_error, text_preview, tool_result_preview
       FROM turns WHERE session_id = ? ORDER BY turn_index`
    )
    .all(sessionId) as Array<{
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
  }>;

  if (turnRows.length === 0) return [];

  // Pull tool calls in one query and group by turn_index for assembly
  // into the UsageTurn shape `detectOneShot` consumes.
  const toolRows = db
    .prepare(
      `SELECT turn_index, sequence_in_turn, tool_name, arguments_json
       FROM tool_uses WHERE session_id = ? ORDER BY turn_index, sequence_in_turn`
    )
    .all(sessionId) as Array<{
    turn_index: number;
    sequence_in_turn: number;
    tool_name: string;
    arguments_json: string | null;
  }>;
  const toolsByTurn = new Map<number, ToolCall[]>();
  for (const r of toolRows) {
    const args = parseStoredArgs(r.arguments_json);
    const list = toolsByTurn.get(r.turn_index) ?? [];
    list.push({ name: r.tool_name, arguments: args });
    toolsByTurn.set(r.turn_index, list);
  }

  return turnRows.map((r): UsageTurn => ({
    timestamp: r.ts,
    sessionId,
    projectSlug,
    projectDirName,
    model: r.model ?? "",
    role: r.role,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreateTokens: r.cache_create_tokens,
    cacheReadTokens: r.cache_read_tokens,
    toolCalls: toolsByTurn.get(r.turn_index) ?? [],
    isError: r.is_error === 1,
    // detectOneShot reads `toolResultText` to find ERROR_PATTERNS in
    // tool result content. Without this, prior failed verifications
    // would look like "no error" after a tail-append and has_one_shot
    // could flip to true incorrectly. text_preview is the truncated
    // human prompt for non-result user turns; tool_result_preview is
    // the truncated tool result for result-bearing user turns.
    userMessageText: r.role === "user" ? (r.text_preview ?? undefined) : undefined,
    toolResultText: r.role === "user" ? (r.tool_result_preview ?? undefined) : undefined,
  }));
}

/**
 * Append the new turns / tool_uses / file_edits from a tail parse and
 * recompute the session row's aggregates over old + new combined.
 *
 * Caller wraps in a transaction. The new turns must already have their
 * `turn_index` shifted past the existing ones (the parser does this via
 * `startTurnIndex`).
 */
function appendSessionTail(
  db: DatabaseT.Database,
  parsed: ParsedSession,
  fileMtimeMs: number,
  fileSize: number
): { rows: number; affectedDays: Set<string> } {
  let rows = 0;
  const sessionId = parsed.sessionId;

  // Insert just the new rows. Reuse the writer prepares from writeSession-
  // style inserts but skip the DELETE FROM sessions step — we're amending,
  // not replacing.
  const insertTurn = db.prepare(
    `INSERT INTO turns (
       session_id, turn_index, ts, role, model,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       is_error, parent_tool_use_id, text_preview, tool_result_preview, category, derived_version
     ) VALUES (
       @session_id, @turn_index, @ts, @role, @model,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @is_error, @parent_tool_use_id, @text_preview, @tool_result_preview, @category, @derived_version
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

  for (const t of parsed.turns) {
    const category = t.role === "assistant" ? classifyTurn(t.usageTurn) : null;
    insertTurn.run({
      session_id: sessionId,
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
      tool_result_preview: t.toolResultPreview,
      category,
      derived_version: DERIVED_VERSION,
    });
    rows++;

    for (const tu of t.toolUses) {
      insertToolUse.run({
        session_id: sessionId,
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

      if (tu.filePath && isFileWriteOp(tu.fileOp)) {
        const result = insertFileEdit.run(sessionId, t.turnIndex, tu.filePath, tu.fileOp, t.ts);
        rows += Number(result.changes);
      }
    }
  }

  // Recompute session aggregates over the union of old + new turns.
  // Cheaper to do it in SQL than to rehydrate everything into JS — the
  // numeric columns are summable directly. primary_model is the
  // most-frequent assistant model. has_one_shot needs JS because the
  // detector is window-based.
  const aggRow = db
    .prepare(
      `SELECT
         COUNT(*) AS turn_count,
         SUM(CASE WHEN role='user'      THEN 1 ELSE 0 END) AS user_turn_count,
         SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS assistant_turn_count,
         SUM(is_error)                                     AS error_count,
         SUM(input_tokens)        AS input_tokens,
         SUM(output_tokens)       AS output_tokens,
         SUM(cache_create_tokens) AS cache_create_tokens,
         SUM(cache_read_tokens)   AS cache_read_tokens,
         MIN(ts) AS start_ts,
         MAX(ts) AS end_ts
       FROM turns WHERE session_id = ?`
    )
    .get(sessionId) as {
    turn_count: number;
    user_turn_count: number;
    assistant_turn_count: number;
    error_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
    start_ts: string | null;
    end_ts: string | null;
  };

  const toolCallCount = (db
    .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = ?")
    .get(sessionId) as { n: number }).n;

  const modelRow = db
    .prepare(
      `SELECT model, COUNT(*) AS n FROM turns
       WHERE session_id = ? AND role='assistant' AND model IS NOT NULL
       GROUP BY model ORDER BY n DESC LIMIT 1`
    )
    .get(sessionId) as { model: string; n: number } | undefined;
  const primaryModel = modelRow?.model ?? null;

  // Cost per assistant turn — same formula as full parse.
  const costRows = db
    .prepare(
      `SELECT model, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens
       FROM turns WHERE session_id = ? AND role='assistant' AND model IS NOT NULL`
    )
    .all(sessionId) as Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  }>;
  let costUsd = 0;
  for (const r of costRows) {
    costUsd += applyPricing(getModelPricing(r.model), {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreateTokens: r.cache_create_tokens,
      cacheReadTokens: r.cache_read_tokens,
    });
  }

  // One-shot detection over old + new combined.
  const allUsageTurns = loadExistingTurnsAsUsage(
    db,
    sessionId,
    parsed.projectSlug,
    parsed.projectDirName
  );
  const oneShot = detectOneShot(allUsageTurns);
  const hasOneShot: 0 | 1 = oneShot.oneShotTasks > 0 ? 1 : 0;

  const cacheTotal = aggRow.cache_create_tokens + aggRow.cache_read_tokens;
  const cacheHitRatio = cacheTotal > 0 ? aggRow.cache_read_tokens / cacheTotal : null;

  // last_prompt: prefer the human prompt parsed from the tail. If the
  // tail was assistant-only (no new human prompt), keep whatever the
  // session already had — `initial_prompt` is the WRONG fallback,
  // it'd regress a multi-prompt session's last prompt back to its
  // first one on the first assistant-only append.
  const promptRow = db
    .prepare("SELECT last_prompt FROM sessions WHERE session_id = ?")
    .get(sessionId) as { last_prompt: string | null } | undefined;
  const lastPrompt = parsed.lastPrompt ?? promptRow?.last_prompt ?? null;

  db.prepare(
    `UPDATE sessions SET
       file_path           = @file_path,
       file_mtime_ms       = @file_mtime_ms,
       file_size           = @file_size,
       byte_offset         = @byte_offset,
       start_ts            = @start_ts,
       end_ts              = @end_ts,
       primary_model       = @primary_model,
       turn_count          = @turn_count,
       user_turn_count     = @user_turn_count,
       assistant_turn_count = @assistant_turn_count,
       tool_call_count     = @tool_call_count,
       error_count         = @error_count,
       input_tokens        = @input_tokens,
       output_tokens       = @output_tokens,
       cache_create_tokens = @cache_create_tokens,
       cache_read_tokens   = @cache_read_tokens,
       cost_usd            = @cost_usd,
       cache_hit_ratio     = @cache_hit_ratio,
       has_one_shot        = @has_one_shot,
       last_prompt         = @last_prompt,
       indexed_at_ms       = @indexed_at_ms
     WHERE session_id = @session_id`
  ).run({
    session_id: sessionId,
    file_path: parsed.filePath,
    file_mtime_ms: fileMtimeMs,
    file_size: fileSize,
    // Same invariant as writeSession: cursor = position after the last
    // consumed `\n`, never `fileSize` (which could be past a partial line).
    byte_offset: parsed.byteOffset,
    start_ts: aggRow.start_ts,
    end_ts: aggRow.end_ts,
    primary_model: primaryModel,
    turn_count: aggRow.turn_count,
    user_turn_count: aggRow.user_turn_count,
    assistant_turn_count: aggRow.assistant_turn_count,
    tool_call_count: toolCallCount,
    error_count: aggRow.error_count,
    input_tokens: aggRow.input_tokens,
    output_tokens: aggRow.output_tokens,
    cache_create_tokens: aggRow.cache_create_tokens,
    cache_read_tokens: aggRow.cache_read_tokens,
    cost_usd: costUsd,
    cache_hit_ratio: cacheHitRatio,
    has_one_shot: hasOneShot,
    last_prompt: lastPrompt,
    indexed_at_ms: Date.now(),
  });
  rows++;

  // affectedDays: union of every (day, project, model) tuple the session
  // currently contributes to (after the append) — old days that no longer
  // have any turns are handled by the caller's old-tuples union, but in
  // a tail, no day disappears. Just emit current-state tuples.
  const affectedDays = new Set<string>();
  const dayRows = db
    .prepare(
      `SELECT DISTINCT substr(ts, 1, 10) AS day, model
       FROM turns WHERE session_id = ? AND role='assistant' AND model IS NOT NULL`
    )
    .all(sessionId) as Array<{ day: string; model: string }>;
  for (const r of dayRows) {
    affectedDays.add(`${r.day}|${parsed.projectSlug}|${r.model}`);
  }

  return { rows, affectedDays };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Override the projects root for tests. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** Force re-parse of every session, ignoring the mtime/size + version gate. */
  force?: boolean;
}

export interface FileReconcileResult {
  /** Row count written across sessions/turns/tool_uses/file_edits. 0 = skipped. */
  rowsWritten: number;
  /** (day|project|model) tuples whose daily_costs row needs recomputing. */
  affectedDays: Set<string>;
}

/**
 * Reconcile a single JSONL file into the DB. Caller is responsible for
 * `loadPricing()` having completed first AND for refreshing daily_costs
 * with the returned `affectedDays` (batched at the end of a multi-file
 * reconcile to avoid recomputing the same tuple N times).
 */
export async function reconcileSessionFile(
  db: DatabaseT.Database,
  filePath: string,
  projectDirName: string,
  options: { force?: boolean } = {}
): Promise<FileReconcileResult> {
  const empty: FileReconcileResult = { rowsWritten: 0, affectedDays: new Set() };
  let mtimeMs: number;
  let size: number;
  try {
    const s = await fs.stat(filePath);
    mtimeMs = Math.floor(s.mtimeMs);
    size = s.size;
  } catch {
    return empty;
  }
  // A session previously ingested at <50 MB that has since grown past the
  // limit will keep its stale row — we return 0 here without re-parsing or
  // pruning. The file-parse path has the same behavior. P2a-2.3's byte_offset
  // tail will let us amend the row incrementally and remove the cap.
  if (size > MAX_SESSION_FILE_SIZE) return empty;

  const sessionId = path.basename(filePath, ".jsonl");
  let existing:
    | {
        file_path: string;
        file_mtime_ms: number;
        file_size: number;
        byte_offset: number;
        derived_version: number;
      }
    | undefined;
  if (!options.force) {
    existing = db
      .prepare(
        "SELECT file_path, file_mtime_ms, file_size, byte_offset, derived_version FROM sessions WHERE session_id = ?"
      )
      .get(sessionId) as typeof existing;
    if (
      existing &&
      existing.file_path === filePath &&
      existing.file_mtime_ms === mtimeMs &&
      existing.file_size === size &&
      existing.derived_version === DERIVED_VERSION
    ) {
      return empty;
    }
  }

  // Decide between tail-append and full-replace. The tail path is only
  // safe when the file grew at the end with no prefix changes, the path
  // is the same, and the derivation version matches what the existing
  // rows were stamped with. Anything else means our cursor is invalid
  // and we have to re-parse from scratch.
  const canTail =
    !options.force &&
    existing !== undefined &&
    existing.file_path === filePath &&
    existing.derived_version === DERIVED_VERSION &&
    size > existing.file_size &&
    mtimeMs >= existing.file_mtime_ms;

  if (canTail) {
    const startTurnIndex = (db
      .prepare("SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_idx FROM turns WHERE session_id = ?")
      .get(sessionId) as { next_idx: number }).next_idx;
    const tailResult = await readJsonlSession(filePath, projectDirName, mtimeMs, size, {
      fromOffset: existing!.byte_offset,
      startTurnIndex,
    });
    // `parsed === null` means "tail had no usable turns" — still update
    // the cursor + file_size so we don't keep re-reading the same
    // trailing junk (e.g., comment lines or sidechain entries). The
    // safe cursor is `safeOffset`, NOT `size` — anything past
    // `safeOffset` is a partial line that hasn't been flushed.
    if (!tailResult || !tailResult.parsed) {
      const newCursor = tailResult?.safeOffset ?? existing!.byte_offset;
      db.prepare(
        "UPDATE sessions SET file_mtime_ms = ?, file_size = ?, byte_offset = ?, indexed_at_ms = ? WHERE session_id = ?"
      ).run(mtimeMs, size, newCursor, Date.now(), sessionId);
      return empty;
    }
    const tailParsed = tailResult.parsed;
    let rows = 0;
    let affectedDays = new Set<string>();
    const txn = db.transaction(() => {
      const result = appendSessionTail(db, tailParsed, mtimeMs, size);
      rows = result.rows;
      affectedDays = result.affectedDays;
    });
    txn();
    return { rowsWritten: rows, affectedDays };
  }

  // Full replace path. Collect tuples the OLD session contributed to so a
  // turn that moves between days/models doesn't leave a stale daily_costs
  // row behind; union with the new affectedDays for the refresh.
  const oldTuples = collectExistingDailyTuples(db, sessionId);

  const fullResult = await readJsonlSession(filePath, projectDirName, mtimeMs, size);
  if (!fullResult || !fullResult.parsed) return empty;

  let rows = 0;
  const txn = db.transaction(() => {
    rows = writeSession(db, fullResult.parsed!);
  });
  txn();
  const affectedDays = new Set<string>(fullResult.parsed.affectedDays);
  for (const tuple of oldTuples) affectedDays.add(tuple);
  return { rowsWritten: rows, affectedDays };
}

/**
 * For an existing session, return the (day|project|model) tuples its
 * assistant turns currently contribute to. Used to ensure those tuples
 * get refreshed when the session is replaced — otherwise a turn that
 * moves between days/models would leave the prior tuple stale.
 */
function collectExistingDailyTuples(db: DatabaseT.Database, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.model AS model
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.session_id = ? AND t.role = 'assistant' AND t.model IS NOT NULL`
    )
    .all(sessionId) as Array<{ day: string; project_slug: string; model: string }>;
  const tuples = new Set<string>();
  for (const r of rows) tuples.add(`${r.day}|${r.project_slug}|${r.model}`);
  return tuples;
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
  // Collected across all changed sessions and the prune pass; one
  // refresh at the end avoids recomputing the same (day, project,
  // model) tuple N times when N sessions touch the same day.
  const affectedDays = new Set<string>();

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
        const result = await reconcileSessionFile(db, filePath, dirName, options);
        if (result.rowsWritten > 0) {
          stats.filesChanged++;
          stats.rowsWritten += result.rowsWritten;
          for (const tuple of result.affectedDays) affectedDays.add(tuple);
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
  const deletePrunedDailyByProject = db.prepare(
    "DELETE FROM daily_costs WHERE project_slug = ?"
  );
  const stalePruned = new Set<string>();
  for (const r of allSessions) {
    if (!liveFilePaths.has(r.file_path)) {
      deleteStale.run(r.session_id);
      stalePruned.add(r.project_slug);
    }
  }

  // Pruned sessions removed cost contributions on their days. We drop the
  // affected projects' daily_costs entirely then re-derive every tuple
  // still present for those projects in `turns`. Cheaper than per-tuple
  // delta math and immune to "project lost its last session for a day".
  if (stalePruned.size > 0) {
    const ph = Array.from(stalePruned).map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.model AS model
         FROM turns t JOIN sessions s USING (session_id)
         WHERE t.role = 'assistant' AND t.model IS NOT NULL
           AND s.project_slug IN (${ph})`
      )
      .all(...Array.from(stalePruned)) as Array<{ day: string; project_slug: string; model: string }>;
    for (const r of rows) affectedDays.add(`${r.day}|${r.project_slug}|${r.model}`);
    for (const slug of stalePruned) deletePrunedDailyByProject.run(slug);
  }

  if (affectedDays.size > 0) {
    refreshDailyCosts(db, affectedDays);
  }

  return stats;
}
