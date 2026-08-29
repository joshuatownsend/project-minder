import { toPrLinkSource } from "@/lib/types/session";
import "server-only";
import path from "path";
import os from "os";
import { performance } from "perf_hooks";
import { promises as fs } from "fs";
import type DatabaseT from "better-sqlite3";
import {
  beginIndexerRun,
  finishIndexerRun,
  type IndexerRunKind,
} from "./indexerRuns";
import { canonicalizeDirName, mostFrequent } from "@/lib/usage/parser";
import { getClaudeHomes, getReadableClaudeHomes } from "@/lib/claudeHome";
import { normalizePathKey, sessionFileHomeKey } from "@/lib/platform";
import { recordHomeCaseSensitivity } from "./homeCaseSensitivity";
import {
  clearStaleDerivationMemo,
  clearDerivationChanged,
  markDerivationChanged,
} from "./indexerRuns";
import { chunkText } from "./textChunks";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import { projectSlugFromDirName } from "@/lib/sessions/projectIdentity";
import { bridgeJsonlAppendToEventBus } from "@/lib/agentView/eventBus";
import { emitMinderEvent } from "@/lib/events/bus";
import { classifyTurn } from "@/lib/usage/classifier";
import {
  detectOneShotTasks,
  summarizeOneShotTasks,
  type OneShotTask,
} from "@/lib/usage/oneShotDetector";
import { computeSessionQuality, turnContextFill, type SessionQualitySummary } from "@/lib/usage/sessionQuality";
import { loadPricing, getModelPricing, applyPricing } from "@/lib/usage/costCalculator";
import { extractCacheCreate1hTokens } from "@/lib/usage/cacheTtl";
import { parseMcpTool } from "@/lib/usage/mcpParser";
import {
  extractText,
  extractToolResults,
  extractToolResultEntries,
  extractCommandNames,
  isHumanText,
} from "@/lib/usage/contentBlocks";
import { categorizeToolError } from "@/lib/usage/toolErrorCategorizer";
import { aggregateWorkMode } from "@/lib/usage/workMode";
import { extractPrsFromEntries } from "@/lib/usage/prExtractor";
import type { PrLink, TicketLink } from "@/lib/types";
import { isFileWriteOp, type FileOp } from "@/lib/usage/toolNames";
import {
  extractFileOp,
  extractAgentName,
  extractSkillName,
  truncateText,
  readTailToLastNewline,
} from "./ingest/parseHelpers";
import {
  safeExtractPrs,
  safeExtractTickets,
  mergePrLinks,
  mergeTicketLinks,
} from "./ingest/merge";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";
import { DERIVED_VERSION } from "./derivationVersion";
import { parseStoredArgs } from "./storedArgs";
import { detectResumeAnomaly } from "@/lib/usage/resumeAnomaly";
import { discoverAllSessions, getAdapter } from "@/lib/adapters";
import type { SessionFile } from "@/lib/adapters/types";
import { readConfig } from "@/lib/config";
import type { MinderConfig } from "@/lib/types";

// ── Optional per-stage profiling ──────────────────────────────────────────
// Gated on `MINDER_PROFILE_INGEST=1` so production stays at zero overhead.
// Used by `scripts/profile-reconcile.mjs` to pinpoint reconcile bottlenecks.
const PROFILE = process.env.MINDER_PROFILE_INGEST === "1";
const ingestTimings: Record<string, number> = {};
function tick(label: string, durMs: number): void {
  if (!PROFILE) return;
  ingestTimings[label] = (ingestTimings[label] ?? 0) + durMs;
}
export function getIngestTimings(): Record<string, number> {
  return { ...ingestTimings };
}
export function resetIngestTimings(): void {
  for (const k of Object.keys(ingestTimings)) delete ingestTimings[k];
}

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

/**
 * Full prose + extended-thinking text of a message, for the chunked FTS
 * index (content tier B — tool inputs/outputs excluded).
 *
 * Used on the sidechain path, which needs the text but not the tool_use
 * blocks. The primary assistant loop deliberately does NOT call this: it
 * extracts text, tool blocks, and the thinking flag in one fused pass over
 * `content`, and splitting that into two passes would double the walk over
 * the hottest loop in ingest for no behavioural gain.
 */
/**
 * Write a turn's full text into `prompts_fts` as overlapping chunks.
 *
 * `prompts_fts` is writer-owned as of schema v19 — the triggers that used
 * to mirror `turns.text_preview` were dropped, because the full body is
 * never stored in `turns` for a trigger to read. Both writers
 * (`writeSession` and `appendSessionTail`) must call this for every turn
 * they insert, or those turns become invisible to prompt-scope search.
 *
 * Cleanup is unchanged and still session-scoped: the existing
 * `DELETE FROM prompts_fts WHERE session_id = ?` contract never keyed on
 * `turn_index`, so it removes every chunk of every turn in one scan.
 *
 * Returns the number of FTS rows written, for the `rowsWritten` metric.
 */
function insertTurnChunks(
  stmt: DatabaseT.Statement,
  sessionId: string,
  turn: Pick<ParsedTurn, "turnIndex" | "role" | "ts" | "searchText">
): number {
  const chunks = chunkText(turn.searchText);
  for (let i = 0; i < chunks.length; i++) {
    stmt.run({
      session_id: sessionId,
      turn_index: turn.turnIndex,
      chunk_index: i,
      role: turn.role,
      ts: turn.ts,
      text: chunks[i],
    });
  }
  return chunks.length;
}

const INSERT_FTS_CHUNK_SQL = `
  INSERT INTO prompts_fts (session_id, turn_index, chunk_index, role, ts, text)
  VALUES (@session_id, @turn_index, @chunk_index, @role, @ts, @text)
`;

function extractProseAndThinking(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) parts.push(b.text);
    else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      parts.push(b.thinking);
    }
  }
  return parts.join("\n");
}

interface IngestStats {
  filesSeen: number;
  filesChanged: number;
  rowsWritten: number;
  errors: number;
  /**
   * Files left untouched because their stored rows were derived by a NEWER
   * build than this one. Counted rather than ignored: this is the one skip
   * that means "your index is ahead of your binary", and a silent version of
   * it is why the 2026-08-05 downgrade was found only by chance, hours later,
   * while investigating why a just-shipped panel rendered nothing.
   */
  newerDerivationSkips: number;
  /**
   * Directories whose enumeration FAILED — a transient UNC/EIO error, a distro
   * that stopped mid-cycle. Distinct from a home deliberately skipped by the
   * never-wake gate, which is the user's configuration doing its job and is
   * already carried by `unavailableDirs`.
   *
   * Load-bearing for readiness (#471): the pass returns ordinary stats after
   * one of these, so without the count a run that never saw an entire home
   * would be recorded `aborted = 0` and permanently latch the index as ready —
   * letting the timecard return the partial total this gate exists to prevent.
   * Codex raised it as a P1 on PR #471; the signal already existed for prune
   * protection and simply was not surfaced.
   */
  enumerationFailures: number;
}

/**
 * Would writing this session with the CURRENT build LOSE information?
 *
 * The staleness gates used to compare `stored === DERIVED_VERSION`, which is
 * true-or-false in both directions: a build at version 12 reading rows stamped
 * 14 concluded "stale" exactly as it would for rows stamped 11, re-derived
 * them, and wrote 12 back — dropping every column the newer build had added.
 *
 * That is not hypothetical. On 2026-08-05 a v14 re-parse wrote 4,894 sessions
 * carrying 22,682 `turns.effort` values and 1,141 `task_outcome` stamps; a tray
 * packaged 2026-08-03 (`DERIVED_VERSION = 12`) started ~30 minutes later, and
 * the index was subsequently observed holding 5,001 sessions all stamped 12
 * with every one of those columns empty. The overwrite itself was not watched
 * happening — but nothing else writes those columns, and a downgrade leaves no
 * other trace, which is precisely the problem: it looks like ordinary work.
 *
 * Derivation versions only ever move forward, so a stored value ABOVE ours
 * means those rows came from a build that knows strictly more than we do. We
 * cannot improve them and must not touch them: leaving a newer row alone costs
 * nothing (the newer build re-derives it on its next sweep), while rewriting
 * one destroys data no re-parse at this version can reconstruct.
 *
 * Deliberately NOT applied under `force`. None of the three watcher call sites
 * pass it — startup, unlink-triggered, and periodic sweeps are all automatic —
 * so `force` is the explicit "rebuild it anyway" escape hatch, the one thing
 * that lets a genuinely rolled-back install re-derive rather than being stuck
 * with rows it can't rewrite. (The other exit is deleting `index.db`, which is
 * always safe: the DB is a derived index, not the source of truth.)
 */
function isNewerDerivation(storedVersion: number): boolean {
  return storedVersion > DERIVED_VERSION;
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
  errorCategory: string | null;
  invocationSource: string | null;
  /**
   * A1: why this call was refused — `permission-rule`, `automode-blocked`,
   * `user-rejected`, `automode-unavailable`. Null when it wasn't refused OR
   * when the transcript predates the field; the two are indistinguishable, so
   * readers must not treat NULL as "allowed".
   */
  denialKind: string | null;
}

interface ParsedTurn {
  turnIndex: number;
  ts: string;
  role: "user" | "assistant";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  /**
   * Portion of `cacheCreateTokens` written at the 1-hour cache TTL, which bills
   * at 2x base input instead of 1.25x. Read by `applyPricing` below and then
   * discarded — deliberately NOT a `turns` column, because the derived
   * `cost_usd` it produces is the thing worth persisting, and adding a column
   * would mean a migration for a value nothing queries.
   */
  cacheCreate1hTokens?: number;
  cacheReadTokens: number;
  isError: 0 | 1;
  parentToolUseId: string | null;
  textPreview: string | null;
  /**
   * FULL turn text for the chunked `prompts_fts` index — assistant prose
   * plus extended-thinking content, or the complete user prompt. Never
   * truncated, and deliberately NOT persisted as a column: it is chunked
   * into FTS rows by the writer and then dropped, which is what keeps the
   * ~150 MB of body text out of the `turns` table on top of the index.
   *
   * `null` when there is nothing to index, and always `null` on the
   * adapter path (Codex/Gemini) — those adapters cap text at 500 chars
   * (`adapters/utils.ts` TEXT_CAP) before ingest ever sees the turn, so
   * full-body indexing is not available there without changing the
   * `SessionAdapter` contract.
   *
   * Excludes tool inputs/outputs by design (content tier B).
   */
  searchText: string | null;
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
  /**
   * Per-turn dollar cost. Computed once in `readJsonlSession` so writers
   * (`writeSession` and `appendSessionTail`) can persist it directly
   * without re-applying pricing. 0 on user turns and on assistant turns
   * with synthetic / unknown model.
   */
  costUsd: number;
  /**
   * Classifier output for assistant turns, null otherwise. Computed once
   * here so the (day, project, category) rollup can be derived alongside
   * (day, project, model) without a second classifier pass.
   */
  category: string | null;
  /**
   * input_tokens / model context window for assistant turns, null otherwise.
   * Persisted as `turns.context_fill` so per-turn diagnosis (compaction-
   * loop runs, near-compaction visualizations) doesn't need to re-derive
   * the model→window lookup at read time. See `getModelContextWindow` for
   * the model→window table.
   */
  contextFill: number | null;
  /** Duration in ms from turn_duration system events, attached by stream walk-back. */
  turnDurationMs: number | null;
  /** Whether this assistant turn has thinking blocks in its content. */
  hasThinking: 0 | 1;
  /** Absolute byte offset of this JSONL line in the session file. Enables on-demand content reads. */
  textOffset: number | null;
  /**
   * 1 for subagent (Task/sidechain) assistant turns (A1). Stored so their
   * tokens/cost fold into the usage totals, but excluded from session-detail /
   * activity / one-shot reads. Primary turns are 0.
   */
  isSidechain: 0 | 1;
  /**
   * A1 decode-layer fields, persisted as `turns` columns. Unlike
   * `cacheCreate1hTokens` above — which is consumed by pricing and discarded —
   * these are the raw signal itself, so there is nothing derived to store in
   * their place and they earn their columns.
   *
   * `undefined` on every pre-2.1.212 transcript; the writer maps that to NULL.
   */
  effort?: string;
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  /**
   * A2: outcome of the verified task this turn STARTED — `one_shot` or
   * `retry`, `undefined` when it started none. Unlike every other field here
   * it is not read off the turn: it is assigned after the fact by
   * `detectOneShotTasks`, which needs the whole session's turn sequence, so
   * it is stamped in the derive block below rather than during the parse walk.
   */
  taskOutcome?: string;
  /**
   * C3: `requestId` from the assistant entry — the join key to OTEL's
   * `attrs.request_id`. Present on 100% of sampled assistant turns; absent on
   * user turns, which make no API request.
   */
  requestId?: string;
}

/**
 * Schema-compatible storage for the `inferSessionStatus` snapshot.
 *
 * The full TypeScript `SessionStatus` (`working | idle | needs_attention`)
 * doesn't fit the existing `sessions.status` CHECK constraint
 * (`'active','inactive','errored','approval','working','waiting','other'`),
 * and changing the constraint requires a SQLite table rebuild — not
 * worth it for what's effectively a one-bit signal. We collapse the
 * inference to "had unresolved pendings at last ingest" (`'waiting'`)
 * vs "no pendings at last ingest" (`'inactive'`) and let the loader
 * apply time-gating against `file_mtime_ms` at read time. That keeps
 * `working / needs_attention` time-fresh without re-ingesting (file
 * mtime advances on every tail-append) at the cost of staleness when
 * a tool resolution arrives via tail-only appends — see
 * `appendSessionTail` for the staleness window note.
 */
type StoredStatus = "waiting" | "inactive";

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
  /**
   * Peak `input_tokens / context_window` across assistant turns, in [0, 1].
   * Persisted as `sessions.max_context_fill` so the SessionsBrowser badge
   * and the Diagnosis panel header can read a single column instead of
   * scanning `turns`. Null when no assistant turn carried `input_tokens`.
   */
  maxContextFill: number | null;
  /**
   * Quality flag pinned to `(0|1)` to match the schema CHECK constraint
   * on `sessions.has_compaction_loop` / `has_tool_failure_streak`. The
   * read-side translates to `boolean` in `sessionsListFromDb`.
   */
  hasCompactionLoop: 0 | 1;
  hasToolFailureStreak: 0 | 1;
  hasOneShot: 0 | 1;
  // detectOneShot's full output, persisted so /api/usage's oneShot
  // aggregate is `SUM(verified_task_count), SUM(one_shot_task_count)
  // FROM sessions WHERE filter` instead of a per-session window scan.
  verifiedTaskCount: number;
  oneShotTaskCount: number;
  /**
   * Snapshot of `inferSessionStatus`'s pending-tools verdict at the
   * end of this parse. `'waiting'` means the last non-sidechain
   * assistant turn had `tool_use` blocks that no subsequent
   * non-sidechain user turn resolved with a matching `tool_result`.
   * `'inactive'` means everything paired up (or there's no assistant
   * turn at all). Loader time-gates the `'waiting'` case against
   * `file_mtime_ms` — see `loadSessionsListFromDb`.
   */
  storedStatus: StoredStatus;
  /**
   * Claude Code's human-readable slug (e.g. `quirky-scribbling-plum`),
   * surfaced as a top-level `"slug"` field on assistant entries in JSONL.
   * Captured as the first non-empty value seen during the parse. Null
   * when no entry exposed one (older Claude Code, very short sessions
   * that never spawned an assistant turn).
   */
  slug: string | null;
  /** Whether any assistant turn in this session had thinking blocks. */
  hasThinking: 0 | 1;
  /** Most-frequent CLI version seen across all entries. Null when absent. */
  cliVersion: string | null;
  /** Number of compact_boundary system events (denominator for post-reconcile anomaly detector). */
  compactBoundaryCount: number;
  /** Whether the resume-anomaly detector fired. Populated by Phase 3 detector; 0 here. */
  hasResumeAnomaly: 0 | 1;
  workModeExplorationPct: number | null;
  workModeBuildingPct: number | null;
  workModeTestingPct: number | null;
  workModeOtherPct: number | null;
  /** Adapter source id (e.g. "claude"). */
  source: string;
  /**
   * Normalized key of the Claude home that owns this session file
   * (`sessionFileHomeKey(filePath)` — see platform.ts), or null for
   * non-Claude adapter sessions and paths with no `/projects/` segment.
   * Persisted as `sessions.home_key` so per-project usage/cost reports can
   * discriminate between configured homes with identical path layouts (#311).
   */
  homeKey: string | null;
  /**
   * A1 session-level decode. `sessionKind` and `entrypoint` are read off
   * `attachment` entries (they do not appear on assistant turns); `aiTitle`
   * comes from a dedicated `type: "ai-title"` entry, re-emitted as the
   * session's subject clarifies, so the last one wins.
   *
   * Null on every transcript predating the fields — which is NOT the same as
   * "interactive session with no title", and read-side code must not conflate
   * the two.
   */
  sessionKind: string | null;
  aiTitle: string | null;
  entrypoint: string | null;
  /** Permission-mode changes, in file order (`type: "permission-mode"`). */
  permissionModes: Array<{ ts: string | null; mode: string }>;
  /** Hook executions from `hookInfos` on SYSTEM entries. One-to-many, hence its own table. */
  hookRuns: Array<{ ts: string | null; command: string; durationMs: number | null }>;
  /** Hook failures from the sibling `hookErrors` array. Not attributable to a specific command. */
  hookErrors: Array<{ ts: string | null; message: string; preventedContinuation: boolean }>;
  /**
   * PRs harvested from `gh pr create` tool_result text (T2.2). Matched
   * by `tool_use_id` (not positional) so parallel Bash dispatches can't
   * cross-link. INSERT OR IGNORE on `session_prs` means a tail-append
   * pass producing the same URLs the first parse already saw is a NOOP.
   */
  prs: PrLink[];
  /**
   * Issue/ticket trackers referenced anywhere in the parsed entries
   * (item 3). Harvested by an all-text URL scan — no `tool_use_id`
   * pairing — so a tail-append pass only re-finds tickets in the new
   * bytes; older ones are carried by `preservedTickets` on rewrite.
   * INSERT OR IGNORE on `session_tickets` makes repeated passes a NOOP.
   */
  tickets: TicketLink[];
  /**
   * #395: `tool_use_id` → tool name, for calls made in SIDECHAIN turns.
   *
   * The counterpart to `tool_uses`, which holds primary turns only and always
   * has. A subagent's tool calls have never been representable in the index at
   * all, which is why the delegation caps could not see nested work: the read
   * side asked a table that structurally could not answer, and got zero.
   *
   * Keyed by id rather than tallied per tool so the write is idempotent — a
   * session can be written across several passes, and dedupe state does not
   * survive between them. One logical call is emitted on as many lines as its
   * message has blocks (#426): 37,394 blocks over 37,311 distinct ids across
   * 1,260 subagent transcripts.
   */
  sidechainToolUses: Map<string, string>;
  turns: ParsedTurn[];
  // (day, project, model) tuples to recompute in daily_costs after this
  // session is replaced.
  affectedDays: Set<string>;
  // (day, project, category) tuples to recompute in category_costs after
  // this session is replaced. Sister set to affectedDays for the
  // category-keyed rollup.
  affectedCategoryTuples: Set<string>;
}

// Tool-call classification helpers (`extractFileOp`, `extractAgentName`,
// `extractSkillName`) moved to `./ingest/parseHelpers` (imported above).

// `parseStoredArgs` and its `COMMAND_RECOVERY_RE` regex moved to
// `./storedArgs` so the read-side data façade (`src/lib/data/usageFromDb.ts`)
// can share the same recovery rules. Imported at the top of this file.

// ── JSONL → ParsedSession ──────────────────────────────────────────────────

// `truncateText` and `readTailToLastNewline` moved to `./ingest/parseHelpers`
// (imported above).

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
  /**
   * T2.2 straddle-recovery signal — true when this parse window contains
   * one or more `tool_result` blocks whose `tool_use_id` isn't matched by
   * a `tool_use` block in the same window. On a tail parse this is the
   * fingerprint of a `gh pr create` Bash call written in the prefix whose
   * result lands in the tail; the caller does a full-file PR re-extract
   * to catch it. Always `false` on full parses (`fromOffset = 0`) since
   * any unmatched result would also be unrecoverable. Read review #1.
   */
  hasOrphanToolResults: boolean;
}

/**
 * A `tool_use` block's name, or `"unknown"` when it has none.
 *
 * `ToolCall.name` and `tool_uses.tool_name` describe the same block, so they
 * have to agree on the malformed case. They did not: the stored row fell back
 * to `"unknown"` while the in-memory `ToolCall` was built by an `any` cast that
 * let `undefined` through a field typed `string` — and that field is what
 * `classifyTurn` matches tool names against, so the two representations of one
 * block disagreed exactly where a name was missing. Shared here so the fallback
 * cannot drift between them again. (Copilot, PR #427.)
 */
function normalizeToolName(name: unknown): string {
  return typeof name === "string" ? name : "unknown";
}

/** Build the classifier-facing `ToolCall` view of a raw `tool_use` block. */
function toToolCall(b: { name?: unknown; input?: unknown }): ToolCall {
  return {
    name: normalizeToolName(b.name),
    arguments: b.input as Record<string, unknown> | undefined,
  };
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
  const projectSlug = projectSlugFromDirName(projectDirName);
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
  const tRead = PROFILE ? performance.now() : 0;
  try {
    const result = await readTailToLastNewline(filePath, fromOffset);
    raw = result.text;
    safeOffset = result.safeOffset;
  } catch {
    return null;
  }
  if (PROFILE) tick("fileRead", performance.now() - tRead);

  const turns: ParsedTurn[] = [];
  let startTs: string | null = null;
  let endTs: string | null = null;
  let gitBranch: string | null = null;
  let initialPrompt: string | null = null;
  let lastPrompt: string | null = null;
  const modelCounts = new Map<string, number>();
  const versionCounts = new Map<string, number>();
  const compactBoundaries: string[] = [];
  let hasThinkingSession = false;
  // Walk-back attachment for turn_duration: index of the last assistant turn pushed.
  let lastAssistantTurnIdx = -1;
  // Running byte offset within `raw` (relative to fromOffset).
  let relativeBytePos = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  let toolCallCount = 0;
  let errorCount = 0;

  // Status-inference state. Mirrors `inferSessionStatus`'s walk
  // (`src/lib/scanner/sessionStatus.ts`) but inlined into the same
  // pass that builds turns/tool_uses so we don't re-read entries.
  // `lastAssistantPendingIds` tracks the most recent non-sidechain
  // assistant turn's tool_use IDs minus any that subsequent
  // non-sidechain user turns have resolved with matching tool_results.
  // After the loop: empty set ⇒ idle (`'inactive'`); non-empty ⇒
  // pending (`'waiting'`). Time-gating to needs_attention/working
  // happens at READ time against `file_mtime_ms`.
  let lastAssistantStopReason: string | null = null;
  let lastAssistantPendingIds: Set<string> = new Set();
  let sawAnyAssistant = false;
  let userTurnCount = 0;
  let assistantTurnCount = 0;
  let slug: string | null = null;
  // A1 session-level decode. Null/empty means "this transcript predates the
  // field", which the read side must keep distinct from a real value.
  let aiTitle: string | null = null;
  let sessionKind: string | null = null;
  let entrypoint: string | null = null;
  const permissionModes: Array<{ ts: string | null; mode: string }> = [];
  const hookRuns: Array<{ ts: string | null; command: string; durationMs: number | null }> = [];
  let sawPrLink = false;
  const hookErrors: Array<{ ts: string | null; message: string; preventedContinuation: boolean }> = [];

  /**
   * Pull hook telemetry off one entry.
   *
   * `durationMs` is genuinely optional — 4,189 of the 20,284 hook records on the
   * local corpus carry a command and no duration. That is "not measured", so it
   * stays NULL; rendering it as 0 ms would make an unmeasured hook look like the
   * fastest one in the list.
   *
   * `hookErrors` is a sibling array of plain strings, NOT a field inside each
   * `hookInfos` entry, so an error cannot be attributed to a specific hook —
   * they are recorded per entry instead of guessed onto a command.
   */
  function collectHookInfo(entry: ConversationEntry): void {
    if (Array.isArray(entry.hookInfos)) {
      for (const h of entry.hookInfos) {
        if (h && typeof h.command === "string" && h.command) {
          hookRuns.push({
            ts: entry.timestamp ?? null,
            command: h.command,
            durationMs: typeof h.durationMs === "number" ? h.durationMs : null,
          });
        }
      }
    }
    if (Array.isArray(entry.hookErrors)) {
      const blocked = entry.preventedContinuation === true;
      for (const msg of entry.hookErrors) {
        if (typeof msg === "string" && msg) {
          hookErrors.push({
            ts: entry.timestamp ?? null,
            message: msg,
            preventedContinuation: blocked,
          });
        }
      }
    }
  }

  // Parse JSONL lines once into an array so the pre-pass and main pass
  // both walk parsed objects — avoids a second JSON.parse per line.
  // Tool results appear in user turns AFTER the assistant turn that called
  // the tool, so two logical passes over the array are still required.
  const rawLines = raw.split("\n");
  const parsedLines: Array<{ line: string; entry: ConversationEntry | null }> = rawLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { line, entry: null };
    try { return { line, entry: JSON.parse(trimmed) as ConversationEntry }; }
    catch { return { line, entry: null }; }
  });

  const errorByToolUseId = new Map<string, { isError: boolean; content: string }>();
  // A1: why a tool call was refused (`permission-rule`, `automode-blocked`,
  // `user-rejected`, `automode-unavailable`). Lives top-level on the USER entry
  // that reports the tool_result, while the `tool_uses` row belongs to the
  // assistant turn that made the call — so it has to be paired by
  // `tool_use_id`, exactly like `errorByToolUseId` beside it. Without this the
  // `denial_kind` column would exist and stay permanently NULL (Codex review,
  // PR #377).
  const denialByToolUseId = new Map<string, string>();
  const slashCommandsByTimestamp = new Map<string, Set<string>>();
  for (const { entry: preEntry } of parsedLines) {
    if (!preEntry || preEntry.type !== "user" || preEntry.isSidechain || preEntry.isMeta || !preEntry.timestamp) continue;
    const msgContent = preEntry.message?.content ?? [];
    const topContent = (preEntry.content ?? []) as unknown[];
    const src = (msgContent as unknown[]).length > 0 ? msgContent : topContent;
    const denialKind =
      typeof preEntry.toolDenialKind === "string" && preEntry.toolDenialKind
        ? preEntry.toolDenialKind
        : null;
    for (const tr of extractToolResultEntries(src)) {
      if (tr.tool_use_id) errorByToolUseId.set(tr.tool_use_id, { isError: tr.isError, content: tr.content });
      if (tr.tool_use_id && denialKind) denialByToolUseId.set(tr.tool_use_id, denialKind);
    }
    const names = extractCommandNames(src);
    if (names.length > 0) slashCommandsByTimestamp.set(preEntry.timestamp, new Set(names));
  }

  // T2.2 orphan-result detector — flags tail parses where at least one
  // `tool_result` block references a `tool_use_id` that isn't in the same
  // parse window. This is the fingerprint of a `gh pr create` whose
  // assistant Bash call lives in the already-persisted prefix but whose
  // result landed in the tail. Caller (`reconcileSessionFile`) does a
  // full-file PR re-extract when this fires so the PR isn't silently lost
  // (review #1). Only meaningful for tails — on a `fromOffset === 0`
  // full parse the recovery is moot because the full file is already in
  // scope.
  let hasOrphanToolResults = false;
  if (fromOffset > 0) {
    const toolUseIds = new Set<string>();
    for (const { entry: e } of parsedLines) {
      if (!e || e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      for (const block of e.message.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          toolUseIds.add(block.id);
        }
      }
    }
    outer: for (const { entry: e } of parsedLines) {
      if (!e || e.type !== "user") continue;
      const ec = (e.message?.content as unknown) ?? (e as { content?: unknown }).content;
      if (!Array.isArray(ec)) continue;
      for (const block of ec as Array<Record<string, unknown>>) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          !toolUseIds.has(block.tool_use_id)
        ) {
          hasOrphanToolResults = true;
          break outer;
        }
      }
    }
  }

  // Tracks the timestamp of the most-recent user turn so the following
  // assistant turn can look up that turn's slash-command set.
  let prevUserTimestamp: string | null = null;
  // A3: text of the most-recent human user prompt, threaded onto the following
  // assistant turns as `userIntentText` so intent-based categories can attribute cost.
  let prevUserText: string | undefined;
  // A6: dedup assistant usage by message.id (fallback requestId) per session.
  // KNOWN LIMITATION (tail path): for an incremental tail parse this set starts
  // empty rather than seeded from the persisted prefix, because turns rows don't
  // carry message.id (no such column). A message re-logged across the byte
  // cursor with the same id therefore isn't recognized and its tokens/cost can
  // be inserted twice. Full-file parses dedup correctly. A proper fix needs a
  // `turns.message_id` column (a schema migration) to seed this set — deferred.
  const seenMessageIds = new Set<string>();
  /**
   * Open assistant messages, keyed by `message.id`, so a later line carrying
   * more of the SAME message merges into the turn already pushed for it.
   *
   * Claude Code writes **one JSONL line per content block**. A message that
   * thought twice and then called two tools is four lines sharing one
   * `message.id`, each repeating the message-level `usage` verbatim. Deduping
   * by that id is right for tokens and was wrong for everything else: the old
   * code `continue`d on the repeat and dropped the block the line carried.
   *
   * Measured on one 47 MB transcript before the fix: 2,716 `tool_use` blocks in
   * the file, 720 rows stored — exactly the count sitting on a first-seen id.
   * `Agent` went 72 → 6, which is why the delegation badge (#395) never fired.
   * Corpus-wide, 5,652 of 6,036 sessions had no `tool_uses` rows at all.
   *
   * The blocks are distinct content, not re-logs: 5,591 distinct against 22
   * exact duplicates across 15 messages. Those 22 are the genuine re-log this
   * guard was written for, and they repeat their `tool_use_id` — so dedupe
   * moves to block level (`toolUseIds` / `blockKeys`) and keeps catching them
   * while the union recovers the rest.
   */
  interface OpenMessage {
    /** Index into `turns` of the row this message's blocks belong to. */
    turnPos: number;
    /** Every text block so far, joined — re-truncated into the turn on merge. */
    text: string;
    /** Every thinking block so far, joined. Feeds `searchText` only. */
    thinking: string;
    /** `tool_use_id`s already stored for this message. */
    toolUseIds: Set<string>;
    /** Text/thinking bodies already stored, to drop an exact re-log. */
    blockKeys: Set<string>;
    /**
     * The slash-command window in force when this message STARTED.
     *
     * Latched rather than read live at merge time. A continuation can arrive
     * after later user turns — the whole reason this map is keyed on
     * `message.id` — and `prevUserTimestamp` would by then name a different
     * prompt, so a `Skill` call split onto a continuation line would be filed
     * as `auto`, or worse, attributed to an unrelated later slash command.
     * (Codex + Copilot, PR #427.)
     */
    slashCmds: Set<string> | undefined;
    /**
     * Whether this message already claimed the pending slash-command window.
     * Per MESSAGE rather than per line: one message is one turn, and a
     * tool split across two lines must not consume the window twice.
     */
    slashConsumed: boolean;
  }
  const openMessages = new Map<string, OpenMessage>();

  /**
   * Convert `tool_use` blocks into storable rows.
   *
   * Shared by the first line of a message and every continuation line, so the
   * two cannot drift — the continuation path is not a reduced copy that forgets
   * to resolve errors or denials. `startIndex` continues `sequenceInTurn` from
   * what the turn already holds, keeping the column a dense 0..n-1 per turn
   * rather than restarting at 0 on each line.
   *
   * `msg` carries the slash-command window across a message's lines; a message
   * with no id (unmergeable) passes undefined and gets a per-call window.
   */
  function buildToolUses(
    blocks: Array<{ id?: string; name?: string; input?: unknown }>,
    startIndex: number,
    msg: OpenMessage | undefined
  ): ParsedToolUse[] {
    // An open message carries the window it started under; only a message with
    // no id (unmergeable, so always its own single line) reads the live cursor.
    const slashCmds = msg
      ? msg.slashCmds
      : prevUserTimestamp
        ? slashCommandsByTimestamp.get(prevUserTimestamp)
        : undefined;
    const window = msg ?? { slashConsumed: false };
    return blocks.map((b, idx): ParsedToolUse => {
      const args = (b.input ?? {}) as Record<string, unknown>;
      const toolName = normalizeToolName(b.name);
      const mcp = parseMcpTool(toolName);
      const { filePath: fp, fileOp } = extractFileOp(toolName, args);
      let argsJson: string | null = null;
      try {
        argsJson = truncateText(JSON.stringify(args), ARGS_JSON_LIMIT);
      } catch {
        argsJson = null;
      }
      const toolUseId = typeof b.id === "string" ? b.id : null;
      const errEntry = toolUseId ? errorByToolUseId.get(toolUseId) : undefined;
      const isError: 0 | 1 = errEntry?.isError ? 1 : 0;
      const errorCategory: string | null =
        isError && errEntry?.content ? categorizeToolError(errEntry.content) : null;
      const skillName = extractSkillName(toolName, args);
      const isSlashMatch =
        !window.slashConsumed && !!slashCmds && !!skillName && slashCmds.has(skillName);
      if (isSlashMatch) window.slashConsumed = true;
      const invocationSource: string = isSlashMatch ? "slash_command" : "auto";
      return {
        sequenceInTurn: startIndex + idx,
        toolUseId,
        toolName,
        mcpServer: mcp?.server ?? null,
        mcpTool: mcp?.tool ?? null,
        agentName: extractAgentName(toolName, args),
        skillName,
        argumentsJson: argsJson,
        filePath: fp,
        fileOp,
        isError,
        errorCategory,
        invocationSource,
        denialKind: toolUseId ? denialByToolUseId.get(toolUseId) ?? null : null,
      };
    });
  }

  /**
   * Fold a continuation line's blocks into the turn its message already owns.
   *
   * Keyed on `message.id`, never on "the previous turn": continuation lines are
   * usually adjacent but not reliably so — across four large transcripts, 6 to
   * 87 continuations per session were separated from their first line, one by
   * 3,639 lines. Nothing here touches tokens, `assistantTurnCount`, or
   * `modelCounts`; the first line already accounted for the whole message.
   */
  function mergeContinuation(messageId: string, content: unknown, lineOffset: number): void {
    const open = openMessages.get(messageId);
    // Straddle: the message's first line landed in an earlier tail chunk, so
    // there is no turn in THIS parse to merge into. Dropping the block matches
    // the previous behaviour rather than inventing a turn whose tokens would
    // double-count — same limitation already documented on `seenMessageIds`.
    if (!open || !Array.isArray(content)) return;
    const turn = turns[open.turnPos];
    if (!turn) return;

    const newTools: Array<{ id?: string; name?: string; input?: unknown }> = [];
    let textChanged = false;
    for (const b of content as any[]) {
      if (b?.type === "text" && typeof b.text === "string" && b.text) {
        const key = `t:${b.text}`;
        if (open.blockKeys.has(key)) continue;
        open.blockKeys.add(key);
        open.text = open.text ? `${open.text}\n${b.text}` : b.text;
        textChanged = true;
      } else if (b?.type === "thinking") {
        // `text_offset` is the ONLY way the timeline retrieves thinking bodies
        // (`readThinkingFromJsonl` reads exactly the one line it points at), and
        // it was set to the message's FIRST line. A message that opened with
        // text and thought on a later line would therefore advertise a thinking
        // event whose content resolves to "unavailable". Point the offset at the
        // first line that actually carries thinking. Only the first: one column
        // holds one offset, so a message that thought several times is still
        // retrievable for its first block only — the same single-block limit
        // that predates this merge, not a new one. (Codex, PR #427.)
        if (!turn.hasThinking) turn.textOffset = lineOffset;
        turn.hasThinking = 1;
        hasThinkingSession = true;
        if (typeof b.thinking === "string" && b.thinking) {
          const key = `k:${b.thinking}`;
          if (open.blockKeys.has(key)) continue;
          open.blockKeys.add(key);
          open.thinking = open.thinking ? `${open.thinking}\n${b.thinking}` : b.thinking;
          textChanged = true;
        }
      } else if (b?.type === "tool_use") {
        const id = typeof b.id === "string" ? b.id : null;
        // The 22 measured exact duplicates repeat their `tool_use_id`. This is
        // where the A6 guard's real job survives the union.
        if (id) {
          if (open.toolUseIds.has(id)) continue;
          open.toolUseIds.add(id);
        }
        newTools.push(b);
      }
    }

    if (textChanged) {
      // Re-derive rather than append: `textPreview` is a truncation of the
      // whole prose and `searchText` interleaves thinking after it, so neither
      // can be extended by concatenation once a cap has been applied.
      turn.textPreview = truncateText(open.text, TEXT_PREVIEW_LIMIT) || null;
      turn.searchText =
        (open.thinking
          ? open.text
            ? `${open.text}\n${open.thinking}`
            : open.thinking
          : open.text) || null;
      turn.usageTurn.assistantText = open.text
        ? open.text.slice(0, USAGE_USER_TEXT_LIMIT)
        : undefined;
    }

    if (newTools.length > 0) {
      const built = buildToolUses(newTools, turn.toolUses.length, open);
      turn.toolUses.push(...built);
      turn.usageTurn.toolCalls.push(...newTools.map(toToolCall));
      toolCallCount += built.length;
      // Pending tool_use ids belong to the CURRENT last assistant turn only.
      // A continuation arriving after later turns (the 3,639-line gap above)
      // must not resurrect an older turn's pendings, which would flip a
      // finished session to 'waiting'.
      if (open.turnPos === lastAssistantTurnIdx) {
        for (const b of newTools) {
          if (typeof b.id === "string") lastAssistantPendingIds.add(b.id);
        }
      }
    }
  }
  // A1: subagent (sidechain) assistant turns collected here, then appended as
  // `turns` rows AFTER the primary detectors run (so status/one-shot/quality
  // stay primary-only) but BEFORE the write + rollup-tuple derivation (so their
  // tokens/cost fold into daily_costs/category_costs and the usage totals).
  /**
   * `message.id` → the sidechain row it is building, the counterpart of
   * {@link openMessages}. `keys` holds the exact block bodies already folded in
   * — the same identity test the primary path uses, deliberately not a
   * substring check, which would drop a short thinking block that happened to
   * appear inside earlier prose.
   */
  const sidechainByMessageId = new Map<string, { pos: number; keys: Set<string> }>();
  const sidechainCollected: Array<{
    ts: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheCreate1hTokens?: number;
    cacheReadTokens: number;
    // A1: subagent turns are assistant turns and carry the same signal. Their
    // effort in particular is worth keeping — a subagent inherits or overrides
    // the parent's effort, which is exactly what A2 wants to compare.
    effort?: string;
    speed?: string;
    /** C3: OTEL join key; subagent turns make API requests too. */
    requestId?: string;
    attributionSkill?: string;
    attributionMcpServer?: string;
    attributionMcpTool?: string;
    userIntentText?: string;
    // parentToolUseID of the spawning Task call, so DB-backed sidechain turns
    // can be grouped by their parent (parity with the file parser).
    parentToolUseId?: string;
    // Full prose + thinking for the chunked FTS index. Subagent transcripts
    // were previously unsearchable at any length (these rows carry
    // `textPreview: null`), so work delegated to a Task agent simply did not
    // appear in search results — a notable blind spot given how much work
    // runs through subagents.
    searchText?: string;
  }> = [];

  /**
   * #395: `tool_use_id` → tool name, for calls made in sidechain turns.
   *
   * Keying by id rather than tallying is what makes this survivable. Claude
   * Code emits one JSONL line per content block, so a message that called three
   * tools arrives as three lines sharing one `message.id`, and a block can be
   * re-logged (83 times in 37,394 blocks locally). A per-tool counter would
   * have to be written additively — the tail path amends a session in place
   * rather than replacing it — so a re-log straddling a window boundary would
   * be added twice and stay wrong until the next full re-parse. Carrying the
   * ids through to the write instead makes `INSERT OR IGNORE` settle it, with
   * no dedupe state needing to survive between parses.
   *
   * A block with no id would be unkeyable and is dropped; none exist in the
   * 37,394 observed (Codex review of #428).
   */
  const sidechainToolUses = new Map<string, string>();
  function collectSidechainTools(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content as Array<{ type?: string; name?: unknown; id?: unknown }>) {
      if (b?.type !== "tool_use") continue;
      if (typeof b.id !== "string" || !b.id) continue;
      // Plain `set`, no first-wins guard: the id IS the identity of the call,
      // so a repeat carries the same name and the guard was unobservable —
      // mutation testing removed it with every test still green.
      sidechainToolUses.set(b.id, normalizeToolName(b.name));
    }
  }

  const tParse = PROFILE ? performance.now() : 0;
  for (const { line, entry } of parsedLines) {
    // Advance byte cursor BEFORE any continues so the offset is correct
    // for every line, including blank and sidechain lines.
    const thisLineOffset = relativeBytePos;
    relativeBytePos += Buffer.byteLength(line + "\n", "utf8");

    if (!entry) continue;

    // Collect CLI version from every entry that carries it.
    if (typeof entry.version === "string" && entry.version) {
      versionCounts.set(entry.version, (versionCounts.get(entry.version) ?? 0) + 1);
    }

    // Handle system entries for meta extraction before the role-gated block.
    if (entry.type === "system") {
      // A6: hook runs ride SYSTEM entries — measured at 4,189 of 4,189 carriers
      // across the local corpus, and zero on assistant entries. The decode used
      // to sit ~40 lines below this branch, under a comment asserting it rode
      // assistant entries, so this unconditional `continue` reached it first and
      // `session_hook_runs` was structurally guaranteed to stay empty. It did:
      // 0 rows on a fully-reconciled 1.5 GB index.
      //
      // Nothing errored, which is why it survived — an empty latency table reads
      // exactly like "no hooks configured".
      collectHookInfo(entry);
      if (entry.subtype === "compact_boundary" && entry.timestamp) {
        compactBoundaries.push(entry.timestamp);
      } else if (
        entry.subtype === "turn_duration" &&
        typeof (entry as any).duration === "number" &&
        lastAssistantTurnIdx >= 0
      ) {
        turns[lastAssistantTurnIdx].turnDurationMs = (entry as any).duration;
      }
      continue;
    }

    // A1: dedicated metadata entry types, decoded BEFORE the `!entry.timestamp`
    // guard below — `ai-title` and `permission-mode` entries carry no timestamp
    // at all (`{type, aiTitle, sessionId}`), so handling them after that guard
    // would silently drop every one of them.
    if (entry.type === "ai-title") {
      // Re-emitted as the session's subject clarifies; last one wins.
      if (typeof entry.aiTitle === "string" && entry.aiTitle) aiTitle = entry.aiTitle;
      continue;
    }
    if (entry.type === "pr-link") {
      // Only a flag here — the actual extraction runs later over `entries`,
      // which is not built yet at this point in the walk. The flag exists so
      // the "nothing to persist" guard below can see that this window carries
      // a PR link even though it produces no turns.
      sawPrLink = true;
      continue;
    }
    if (entry.type === "permission-mode") {
      if (typeof entry.permissionMode === "string" && entry.permissionMode) {
        permissionModes.push({ ts: entry.timestamp ?? null, mode: entry.permissionMode });
      }
      continue;
    }
    if (entry.type === "attachment") {
      // Session-shaped metadata rides attachments, not assistant turns. First
      // non-empty wins: these are constant for a session, so latching early
      // avoids a late malformed entry overwriting a good value.
      if (!sessionKind && typeof entry.sessionKind === "string" && entry.sessionKind) {
        sessionKind = entry.sessionKind;
      }
      if (!entrypoint && typeof entry.entrypoint === "string" && entry.entrypoint) {
        entrypoint = entry.entrypoint;
      }
      // Fall through: attachments are otherwise handled by the existing logic.
    }
    // Hook info is collected in the `system` branch above, which is where it
    // actually lives. Kept here as a safety net in case a future release moves
    // it onto another entry type — `collectHookInfo` dedupes nothing, but the
    // `system` branch `continue`s, so no entry can reach both calls.
    collectHookInfo(entry);

    if (entry.isMeta || !entry.timestamp) continue;
    // A1: subagent (sidechain) turns don't participate in status inference,
    // one-shot/quality detection, or tool_uses — but their assistant-turn
    // tokens/cost must fold into the usage totals. Collect them here and append
    // as rows after the primary pass; then `continue` so the primary logic below
    // is untouched (identical to the pre-A1 skip for every other purpose).
    if (entry.isSidechain) {
      if (entry.type === "assistant") {
        collectSidechainTools(entry.message?.content);
        const model = entry.message?.model;
        if (model && model !== "<synthetic>") {
          const messageId =
            (entry.message as { id?: string } | undefined)?.id ??
            (entry as { requestId?: string }).requestId;
          if (messageId && seenMessageIds.has(messageId)) {
            // Same continuation rule as the primary path: a repeat id is more
            // of this message, so its prose joins the row already collected
            // instead of being dropped. Sidechain rows carry no `tool_uses`
            // (by design — see the A1 note above), so only `searchText` can
            // grow here; tokens stay first-line-only exactly as before.
            const open = sidechainByMessageId.get(messageId);
            const more = extractProseAndThinking(entry.message?.content);
            if (open && more && !open.keys.has(more)) {
              open.keys.add(more);
              const row = sidechainCollected[open.pos];
              if (row) {
                row.searchText = row.searchText ? `${row.searchText}\n${more}` : more;
              }
            }
          } else {
            if (messageId) {
              seenMessageIds.add(messageId);
              const first = extractProseAndThinking(entry.message?.content);
              sidechainByMessageId.set(messageId, {
                pos: sidechainCollected.length,
                keys: new Set(first ? [first] : []),
              });
            }
            const usage = entry.message?.usage ?? {};
            sidechainCollected.push({
              ts: entry.timestamp,
              model,
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
              cacheCreate1hTokens: extractCacheCreate1hTokens(usage),
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              effort: entry.effort,
              requestId: (entry as { requestId?: string }).requestId,
              speed: usage.speed ?? undefined,
              attributionSkill: entry.attributionSkill,
              attributionMcpServer: entry.attributionMcpServer,
              attributionMcpTool: entry.attributionMcpTool,
              userIntentText: prevUserText,
              parentToolUseId: entry.parentToolUseID ?? undefined,
              searchText: extractProseAndThinking(entry.message?.content) || undefined,
            });
          }
        }
      }
      continue;
    }
    const { type, timestamp } = entry;
    if (type !== "assistant" && type !== "user") continue;

    if (!startTs) startTs = timestamp;
    endTs = timestamp;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;

    const turnIndex = startTurnIndex + turns.length;

    if (type === "assistant") {
      // Slug appears on assistant entries only — capture from the first
      // one we see so a malformed or out-of-band entry with a foreign
      // slug can't poison the session's stable identifier (and the
      // `COALESCE(slug, @slug)` write-side ensures that latch holds
      // across tail-appends).
      if (!slug && typeof entry.slug === "string" && entry.slug.length > 0) {
        slug = entry.slug;
      }
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;
      // A6: a repeat `message.id` is the same message CONTINUING, not a
      // re-logged one — Claude Code emits one line per content block. Tokens
      // stay first-line-only (every line repeats them verbatim, measured
      // 3,248 identical / 0 differing), while the block this line carries
      // merges into the turn already pushed for the message. See
      // `openMessages` for what the old unconditional `continue` cost.
      const messageId =
        (entry.message as { id?: string } | undefined)?.id ??
        (entry as { requestId?: string }).requestId;
      if (messageId && seenMessageIds.has(messageId)) {
        mergeContinuation(messageId, entry.message?.content, fromOffset + thisLineOffset);
        continue;
      }
      if (messageId) seenMessageIds.add(messageId);
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);

      const usage = entry.message?.usage ?? {};
      const ti = usage.input_tokens ?? 0;
      const to = usage.output_tokens ?? 0;
      const tcc = usage.cache_creation_input_tokens ?? 0;
      // Portion of `tcc` written at the 1-hour TTL (2x base) rather than the
      // 5-minute default (1.25x). Carried on the in-memory turn only — it feeds
      // `applyPricing` below, and the resulting `cost_usd` is what gets stored.
      const tcc1h = extractCacheCreate1hTokens(usage);
      const tcr = usage.cache_read_input_tokens ?? 0;
      inputTokens += ti;
      outputTokens += to;
      cacheCreateTokens += tcc;
      cacheReadTokens += tcr;

      const isError = entry.isApiErrorMessage === true ? 1 : 0;
      if (isError) errorCount++;
      assistantTurnCount++;

      const content = entry.message?.content ?? [];
      // Single pass: extract text, tool_use blocks, and thinking together.
      let text = "";
      let thinkingText = "";
      let hasTurnThinking = false;
      const toolBlocks: Array<{ id?: string; name?: string; input?: unknown }> = [];
      // Per-block identity for this message, so a later line that repeats a
      // block verbatim (a genuine re-log) is dropped while a later line
      // carrying a NEW block is merged. Keyed per block rather than on the
      // joined text, which would stop matching once two blocks are joined.
      const blockKeys = new Set<string>();
      if (Array.isArray(content)) {
        for (const b of content as any[]) {
          if (b?.type === "text" && typeof b.text === "string") {
            blockKeys.add(`t:${b.text}`);
            if (text) text += "\n";
            text += b.text;
          } else if (b?.type === "tool_use") {
            toolBlocks.push(b);
          } else if (b?.type === "thinking") {
            hasTurnThinking = true;
            hasThinkingSession = true;
            // Capture the reasoning body for the full-body FTS index. This
            // block used to set the flag and drop the content on the floor,
            // which is why "what was Claude thinking when it chose X" was
            // never searchable. Feeds `searchText` ONLY — deliberately kept
            // out of `text`, because `text` flows into `textPreview`,
            // `usageTurn.assistantText`, and from there into the classifier
            // and self-correction detectors, whose thresholds are tuned on
            // user-visible prose. Mixing thinking in there would change
            // classification verdicts as a side effect of a search change.
            if (typeof b.thinking === "string" && b.thinking) {
              blockKeys.add(`k:${b.thinking}`);
              if (thinkingText) thinkingText += "\n";
              thinkingText += b.thinking;
            }
          }
        }
      }
      const textPreview = truncateText(text, TEXT_PREVIEW_LIMIT);
      // Tier B: prose + thinking, no tool I/O. Tool payloads are ~60% of
      // total transcript volume and are mostly grep output and file dumps —
      // high index cost, low search signal, and the underlying files are on
      // disk anyway.
      const searchText = thinkingText ? (text ? `${text}\n${thinkingText}` : thinkingText) : text;

      // Register the message as open BEFORE the turn is pushed: `turns.length`
      // is the index this turn is about to occupy, and nothing pushes between
      // here and the push below. A message with no id stays unmergeable — the
      // pre-existing shape where each of its lines becomes its own turn.
      const openMessage: OpenMessage | undefined = messageId
        ? {
            turnPos: turns.length,
            text,
            thinking: thinkingText,
            toolUseIds: new Set(
              toolBlocks.flatMap((b) => (typeof b.id === "string" ? [b.id] : []))
            ),
            blockKeys,
            slashConsumed: false,
            slashCmds: prevUserTimestamp
              ? slashCommandsByTimestamp.get(prevUserTimestamp)
              : undefined,
          }
        : undefined;
      if (messageId && openMessage) openMessages.set(messageId, openMessage);

      const toolUses = buildToolUses(toolBlocks, 0, openMessage);
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
        cacheCreate1hTokens: tcc1h,
        cacheReadTokens: tcr,
        toolCalls: toolBlocks.map(toToolCall),
        // Cap to the same 500-char limit the file-parse path applies via
        // `extractText`. Without this, DB-ingest produces a longer
        // projection than file-parse and `selfCorrection.textHasSelfCorrection`
        // can fire on phrases past char 500 only when MINDER_USE_DB=1.
        assistantText: text ? text.slice(0, USAGE_USER_TEXT_LIMIT) : undefined,
        isError: !!isError,
        // A3: triggering user prompt, so classifyTurn can attribute intent.
        userIntentText: prevUserText,
        // A1: mirrors the file-parse path so `MINDER_USE_DB=0/1` agree. `effort`
        // and the attribution fields are top-level on the entry; `speed` lives
        // under usage and is nullable, so null collapses to undefined — both
        // mean unknown.
        effort: entry.effort,
        speed: usage.speed ?? undefined,
        attributionSkill: entry.attributionSkill,
        attributionMcpServer: entry.attributionMcpServer,
        attributionMcpTool: entry.attributionMcpTool,
      };

      lastAssistantTurnIdx = turns.length;
      turns.push({
        turnIndex,
        ts: timestamp,
        role: "assistant",
        model,
        inputTokens: ti,
        outputTokens: to,
        cacheCreateTokens: tcc,
        cacheCreate1hTokens: tcc1h,
        cacheReadTokens: tcr,
        isError,
        parentToolUseId: null,
        textPreview,
        searchText: searchText || null,
        toolResultPreview: null,
        toolUses,
        usageTurn,
        costUsd: 0,
        category: null,
        contextFill: null,
        turnDurationMs: null,
        hasThinking: hasTurnThinking ? 1 : 0,
        textOffset: fromOffset + thisLineOffset,
        isSidechain: 0,
        effort: entry.effort,
        requestId: (entry as { requestId?: string }).requestId,
        attributionSkill: entry.attributionSkill,
        attributionMcpServer: entry.attributionMcpServer,
        attributionMcpTool: entry.attributionMcpTool,
      });

      // Status inference: this assistant turn becomes the new "last
      // assistant" — capture its stop_reason and reset the pending set
      // to its tool_use IDs. Subsequent user turns can shrink this set
      // by resolving tool_results.
      sawAnyAssistant = true;
      lastAssistantStopReason =
        typeof entry.message?.stop_reason === "string" ? entry.message.stop_reason : null;
      lastAssistantPendingIds = new Set();
      for (const b of toolBlocks) {
        if (typeof b.id === "string") lastAssistantPendingIds.add(b.id);
      }
    } else {
      // user turn
      userTurnCount++;
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = (entry.content ?? []) as any[];
      const textSource = messageContent.length > 0 ? messageContent : topLevelContent;
      // Claude Code stores HUMAN-typed user turns as raw strings on
      // `message.content` (assistant turns and tool-result turns use arrays
      // of typed blocks). `extractText()` is intentionally array-only — its
      // job is to walk `{type, text}` block lists — so a string `textSource`
      // would silently return `""` and we'd never extract `initialPrompt` /
      // `lastPrompt` for real human prompts. The file-parse path side-stepped
      // this via its own `extractHumanText` (which handles strings), and the
      // DB path didn't, which is why /api/sessions returned populated
      // `searchableText` (built from assistant array blocks) alongside
      // empty prompt fields and Home's Live activity card read "(no prompt)"
      // for every session. Slicing applies to either shape.
      // Extract ONCE at full length, then cap. `USAGE_USER_TEXT_LIMIT` is a
      // parity contract with the file-parse path (see its definition) — the
      // classifier, one-shot detector, and self-correction check must see
      // identical text on both backends, so the capped value is what flows
      // into `usageTurn`. The uncapped value feeds only the FTS index, which
      // no detector reads.
      const fullUserText =
        typeof textSource === "string" ? textSource : extractText(textSource);
      const userText = fullUserText.slice(0, USAGE_USER_TEXT_LIMIT);
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
        // Tier B excludes tool results, so a tool-result-only user turn
        // contributes nothing to the index — correct: its content is tool
        // I/O wearing a user-turn costume, not something a human wrote.
        searchText: fullUserText || null,
        toolResultPreview: toolResultText || null,
        toolUses: [],
        usageTurn,
        costUsd: 0,
        category: null,
        contextFill: null,
        turnDurationMs: null,
        hasThinking: 0,
        textOffset: null,
        isSidechain: 0,
      });

      // Status inference: walk this user turn's content for
      // tool_result blocks and shrink the pending set. Mirrors the
      // forward-walk in `inferSessionStatus` (lines 53-63 there),
      // including its `if (!Array.isArray(userContent)) continue`
      // guard — `entry.message.content` can be a string (the Claude
      // API allows that), and `messageContent.length > 0` is true for
      // non-empty strings, so without the array gate `for..of` would
      // iterate characters and `b?.type` would be undefined for each.
      if (
        sawAnyAssistant &&
        lastAssistantPendingIds.size > 0 &&
        Array.isArray(textSource)
      ) {
        for (const b of textSource as any[]) {
          if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            lastAssistantPendingIds.delete(b.tool_use_id);
          }
        }
      }
      prevUserTimestamp = timestamp;
      // A3: capture the human prompt text (handles both string and array
      // shapes via `userText` above) for propagation onto following assistant turns.
      if (userText) prevUserText = userText;
    }
  }

  if (PROFILE) tick("parseTurns", performance.now() - tParse);
  // Skip only when the window yielded NOTHING to persist. A full session always
  // has primary turns (a subagent runs inside a parent that has them), but a
  // *tail* window can legitimately contain only sidechain (subagent) entries —
  // the indexer ran between a parent Agent call and the next primary turn.
  // Those rows still carry tokens/cost that must fold into the usage rollups;
  // returning null here would advance byte_offset past them and lose them
  // (PR #250 re-review). So proceed whenever we collected any sidechain turns —
  // the derivations below no-op cleanly on empty primary turns, and the
  // sidechain rows are appended and priced afterward.
  //
  // A1 adds a third case with exactly the same shape: a tail window can contain
  // ONLY metadata entries — an `ai-title`, or a `permission-mode` switch — which
  // produce no turns at all. Returning null for those advances the cursor past
  // them, so the title or mode change is lost permanently rather than merely
  // deferred (Codex review, PR #377). `sessionKind`/`entrypoint` are excluded
  // from this test on purpose: they ride attachments that always accompany
  // turns, so they cannot be the sole content of a window.
  // `pr-link` belongs in this list for exactly the same reason as `ai-title`
  // and `permission-mode`, and A5 missed it. A tail window holding only a
  // `pr-link` entry produced no turns and no A1 metadata, so the guard returned
  // null and the cursor advanced PAST it — the link was lost permanently, not
  // deferred. That is the real failure behind the "scraped row never gets
  // promoted" symptom reported in review: the promoting write never ran at all,
  // because the whole window was discarded.
  const hasA1Metadata =
    aiTitle !== null || permissionModes.length > 0 || hookRuns.length > 0 ||
    hookErrors.length > 0 || sawPrLink;
  if (turns.length === 0 && sidechainCollected.length === 0 && !hasA1Metadata) {
    return { parsed: null, safeOffset, hasOrphanToolResults };
  }

  const primaryModel = mostFrequent(modelCounts);
  const cliVersion = mostFrequent(versionCounts);

  // Derive: per-turn cost + classifier category. Stamp on the ParsedTurn
  // so writers can persist directly without redoing the work. Sum to the
  // session-level total for the row.
  let costUsd = 0;
  const tClassify = PROFILE ? performance.now() : 0;
  for (const t of turns) {
    if (t.role === "assistant") {
      t.category = classifyTurn(t.usageTurn);
      if (t.model) {
        // `speed` rides on the UsageTurn projection, not on ParsedTurn itself.
        t.costUsd = applyPricing(getModelPricing(t.model, t.usageTurn.speed), t);
        costUsd += t.costUsd;
      }
    }
  }
  if (PROFILE) tick("classify+price", performance.now() - tClassify);

  // Derive: work-mode distribution across categorized assistant turns.
  const workMode = aggregateWorkMode(turns.map((t) => ({ category: t.category })));

  // Derive: one-shot detection across the whole session.
  const allUsageTurns = turns.map((t) => t.usageTurn);
  const tOneShot = PROFILE ? performance.now() : 0;
  const oneShotTasks = detectOneShotTasks(allUsageTurns);
  const oneShot = summarizeOneShotTasks(oneShotTasks);
  // A2: stamp each task's outcome onto its anchor turn. `allUsageTurns` is a
  // 1:1 projection of `turns`, so the detector's index IS the array index here
  // — but it is NOT `turnIndex`, which starts at `startTurnIndex` on a tail.
  for (const task of oneShotTasks) {
    const anchor = turns[task.anchorIndex];
    if (anchor) anchor.taskOutcome = task.oneShot ? "one_shot" : "retry";
  }
  if (PROFILE) tick("detectOneShot", performance.now() - tOneShot);
  const hasOneShot: 0 | 1 = oneShot.oneShotTasks > 0 ? 1 : 0;

  // Derive: per-session quality flags (#100/#102/#104) plus cache hit ratio.
  // Detector output is the source of truth; ingest persists onto `sessions`
  // so the list view's badges are a single-column read, and per-turn
  // `context_fill` is stamped onto each assistant turn for the Diagnosis
  // panel. `safeComputeQuality` keeps a buggy detector from bricking a row.
  const tQuality = PROFILE ? performance.now() : 0;
  const { quality, hasCompactionLoop, hasToolFailureStreak, maxContextFill } =
    safeComputeQuality(allUsageTurns, sessionId, "ingest");
  if (quality) {
    for (const t of turns) {
      t.contextFill = turnContextFill(t.usageTurn);
    }
  }
  // Cache hit ratio: read from the detector when available; otherwise fall
  // back to the same `cache_read / total` math against the running totals
  // so a detector failure still leaves a populated column.
  const cacheHitRatio =
    quality?.cache.hitRatio ??
    (cacheCreateTokens + cacheReadTokens > 0
      ? cacheReadTokens / (cacheCreateTokens + cacheReadTokens)
      : null);
  if (PROFILE) tick("sessionQuality", performance.now() - tQuality);

  // Derive: resume anomaly — run after turns are collected with full token data.
  let hasResumeAnomaly: 0 | 1 = 0;
  if (compactBoundaries.length > 0 || cliVersion) {
    try {
      const anomaly = detectResumeAnomaly(allUsageTurns, { compactBoundaries, cliVersion });
      if (anomaly.hasAnomaly) hasResumeAnomaly = 1;
    } catch {
      // fail-soft: leave hasResumeAnomaly = 0
    }
  }

  // Primary turn count captured BEFORE appending sidechain rows so
  // `sessions.turn_count` (a session-summary field, primary-only, mirrored by
  // the file-parse ClaudeUsageStats) excludes subagent turns. The usage totals
  // read `COUNT(*)`/`SUM` over the `turns` rows directly and DO include them.
  const primaryTurnCount = turns.length;

  // A1: append subagent (sidechain) turns as `turns` rows now — AFTER the
  // primary detectors above (status/one-shot/quality/work-mode/resume all ran
  // over primary turns only) and BEFORE the rollup-tuple derivation below (so
  // their tokens/cost flow into daily_costs/category_costs and the usage
  // totals). turn_index continues after the last primary turn so primary
  // indices — and the (session_id, turn_index) tool_uses join — are unchanged.
  // No tool_uses are created for these rows, so tool/shell/mcp stats exclude
  // them automatically. Their cost is NOT added to the session-level `costUsd`
  // (that column stays primary-only for the session list); the usage totals
  // read `SUM(turns.cost_usd)` which includes these rows.
  for (const sc of sidechainCollected) {
    const usageTurn: UsageTurn = {
      timestamp: sc.ts,
      sessionId,
      projectSlug,
      projectDirName: canonicalDir,
      model: sc.model,
      role: "assistant",
      inputTokens: sc.inputTokens,
      outputTokens: sc.outputTokens,
      cacheCreateTokens: sc.cacheCreateTokens,
      cacheCreate1hTokens: sc.cacheCreate1hTokens,
      cacheReadTokens: sc.cacheReadTokens,
      toolCalls: [],
      userIntentText: sc.userIntentText,
      isSidechain: true,
      parentToolUseId: sc.parentToolUseId,
    };
    const category = classifyTurn(usageTurn);
    const scCost = applyPricing(getModelPricing(sc.model, sc.speed), {
      inputTokens: sc.inputTokens,
      outputTokens: sc.outputTokens,
      cacheCreateTokens: sc.cacheCreateTokens,
      cacheCreate1hTokens: sc.cacheCreate1hTokens,
      cacheReadTokens: sc.cacheReadTokens,
    });
    turns.push({
      turnIndex: startTurnIndex + turns.length,
      ts: sc.ts,
      role: "assistant",
      model: sc.model,
      inputTokens: sc.inputTokens,
      outputTokens: sc.outputTokens,
      cacheCreateTokens: sc.cacheCreateTokens,
      cacheReadTokens: sc.cacheReadTokens,
      isError: 0,
      parentToolUseId: sc.parentToolUseId ?? null,
      textPreview: null,
      // Sidechain rows carry no preview column (they never did), but their
      // body IS indexed — see the field note on `sidechainCollected`.
      searchText: sc.searchText ?? null,
      toolResultPreview: null,
      toolUses: [],
      usageTurn,
      costUsd: scCost,
      category,
      contextFill: null,
      turnDurationMs: null,
      hasThinking: 0,
      textOffset: null,
      isSidechain: 1,
      effort: sc.effort,
      // C3 + Codex review: the collector captured `requestId` and this
      // conversion dropped it, so every subagent turn stored request_id = NULL
      // and could never join to OTEL — silently excluding subagents from the
      // correlation while the coverage figure reported success on the rest.
      requestId: sc.requestId,
      attributionSkill: sc.attributionSkill,
      attributionMcpServer: sc.attributionMcpServer,
      attributionMcpTool: sc.attributionMcpTool,
    });
  }

  // Sidechain-only file (e.g. a `subagents/agent-*.jsonl` transcript): the
  // primary loop never ran, so start/end are still null. Derive them from
  // the sidechain rows so the session row gets real time bounds. Primary
  // sessions are untouched — their bounds stay primary-only.
  if (!startTs && turns.length > 0) {
    let minTs = turns[0].ts;
    let maxTs = turns[0].ts;
    for (const t of turns) {
      if (t.ts < minTs) minTs = t.ts;
      if (t.ts > maxTs) maxTs = t.ts;
    }
    startTs = minTs;
    endTs = maxTs;
  }

  // Derive: affected (day, project, model) tuples for daily_costs.
  const affectedDays = new Set<string>();
  // Sister set keyed on category instead of model. Drives the
  // `category_costs` rollup. Only assistant turns contribute (user turns
  // have no category).
  const affectedCategoryTuples = new Set<string>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const day = t.ts.slice(0, 10); // YYYY-MM-DD
    if (t.model) {
      affectedDays.add(`${day}|${projectSlug}|${t.model}`);
    }
    if (t.category) {
      affectedCategoryTuples.add(`${day}|${projectSlug}|${t.category}`);
    }
  }

  // Derive: stored status snapshot. Mirrors `inferSessionStatus`'s
  // exit conditions, scoped to the LAST non-sidechain assistant turn
  // (older assistant turns aren't considered — same as the canonical
  // algorithm's `walk backward to find the last meaningful assistant
  // turn`):
  //   - No assistant turn at all → idle (`'inactive'`).
  //   - Last assistant ended with `stop_reason === 'end_turn'` AND
  //     its tool_use blocks (if any) are all resolved → idle.
  //   - Last assistant has pending tool_uses unresolved by subsequent
  //     non-sidechain user tool_results → waiting.
  //   - Otherwise (every pending was resolved) → idle.
  // Time-gating to working/needs_attention happens at READ time
  // against `file_mtime_ms`, so this snapshot only encodes the
  // pending-vs-resolved bit, not the freshness classification.
  let storedStatus: StoredStatus = "inactive";
  if (sawAnyAssistant) {
    const naturalCompletion =
      lastAssistantStopReason === "end_turn" && lastAssistantPendingIds.size === 0;
    if (!naturalCompletion && lastAssistantPendingIds.size > 0) {
      storedStatus = "waiting";
    }
  }

  // Filter to non-null parsed entries once and share between the PR and
  // ticket extractors — both walk the identical entry list.
  const entries: ConversationEntry[] = [];
  for (const { entry } of parsedLines) if (entry) entries.push(entry);

  return {
    parsed: {
      sessionId,
      projectDirName: canonicalDir,
      projectSlug,
      filePath,
      fileMtimeMs,
      fileSize,
      byteOffset: safeOffset,
      sidechainToolUses,
      startTs,
      endTs,
      primaryModel,
      gitBranch,
      initialPrompt,
      lastPrompt,
      turnCount: primaryTurnCount,
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
      maxContextFill,
      hasCompactionLoop,
      hasToolFailureStreak,
      hasOneShot,
      verifiedTaskCount: oneShot.totalVerifiedTasks,
      oneShotTaskCount: oneShot.oneShotTasks,
      storedStatus,
      slug,
      hasThinking: hasThinkingSession ? 1 : 0,
      cliVersion,
      compactBoundaryCount: compactBoundaries.length,
      hasResumeAnomaly,
      workModeExplorationPct: workMode.exploration,
      workModeBuildingPct: workMode.building,
      workModeTestingPct: workMode.testing,
      workModeOtherPct: workMode.other,
      source: "claude",
      homeKey: sessionFileHomeKey(filePath),
      sessionKind,
      aiTitle,
      entrypoint,
      permissionModes,
      hookRuns,
      hookErrors,
      // Run the PR extractor on the already-parsed entries. The walk is
      // cheap (no JSON.parse hit; reuses `parsedLines.entry`) and skips
      // sessions that never invoked `gh pr create`. A throw here would
      // poison the whole session insert, so wrap defensively — the
      // session still indexes, the PR chip just doesn't render.
      prs: safeExtractPrs(entries, sessionId),
      // Same defensive wrapper as PRs — a throw must index the session
      // anyway, just without ticket chips.
      tickets: safeExtractTickets(entries, sessionId),
      turns,
      affectedDays,
      affectedCategoryTuples,
    },
    safeOffset,
    hasOrphanToolResults,
  };
}

// PR/ticket extraction + merge helpers (`safeExtractPrs`, `safeExtractTickets`,
// `mergePrLinks`, `mergeTicketLinks`) moved to `./ingest/merge` (imported above).

/**
 * T2.2 straddle-recovery (review #1). Reads the full JSONL file from
 * byte 0, runs the PR extractor against every parsed entry, and
 * `INSERT OR IGNORE`s each PR. Used by `reconcileSessionFile` ONLY when
 * the tail parse flagged `hasOrphanToolResults` — i.e., a `tool_result`
 * referenced a `tool_use_id` we don't have in tail scope. Cheap on small
 * files (~10 ms for 5 MB), bounded by `MAX_SESSION_FILE_SIZE` (50 MB) at
 * the worst case. Soft-fails on any error so a recovery glitch never
 * blocks the tail-append's primary correctness.
 */
async function recoverStraddledPrs(
  db: DatabaseT.Database,
  filePath: string,
  sessionId: string,
): Promise<number> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n");
    const entries: ConversationEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as ConversationEntry);
      } catch {
        /* skip malformed line */
      }
    }
    const allPrs = extractPrsFromEntries(entries);
    if (allPrs.length === 0) return 0;
    const insertSessionPr = db.prepare(
      `INSERT INTO session_prs (session_id, pr_url, pr_number, repo, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, pr_url) DO UPDATE SET
         source = 'recorded',
         repo   = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE session_prs.repo END
       WHERE excluded.source = 'recorded'
         AND (session_prs.source IS NOT 'recorded'
              OR (excluded.repo <> '' AND session_prs.repo IS NOT excluded.repo))`,
    );
    let recovered = 0;
    const txn = db.transaction(() => {
      for (const pr of allPrs) {
        const result = insertSessionPr.run(sessionId, pr.url, pr.number, pr.repo, pr.source ?? null);
        recovered += Number(result.changes ?? 0);
      }
    });
    txn();
    return recovered;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ingest] PR straddle-recovery failed for ${sessionId}:`, err);
    return 0;
  }
}

// ── Quality detector wrapper ───────────────────────────────────────────────

interface QualityFlags {
  quality: SessionQualitySummary | null;
  hasCompactionLoop: 0 | 1;
  hasToolFailureStreak: 0 | 1;
  maxContextFill: number | null;
}

/**
 * Run `computeSessionQuality` with a fail-soft fallback. A throw in any
 * future detector would otherwise abort the session's INSERT/UPDATE,
 * leaving `byte_offset` and `derived_version` stuck so every subsequent
 * sweep re-throws on the same file. On failure we log and persist neutral
 * flags — same shape the file-parse path already adopts. `quality` is
 * returned as `null` on failure so callers reading `quality.cache.hitRatio`
 * fall back to their own inline math.
 */
function safeComputeQuality(
  allUsageTurns: UsageTurn[],
  sessionId: string,
  label: "ingest" | "ingest tail"
): QualityFlags {
  try {
    const quality = computeSessionQuality(allUsageTurns);
    return {
      quality,
      hasCompactionLoop: quality.compactionLoops.length > 0 ? 1 : 0,
      hasToolFailureStreak: quality.toolFailureStreaks.length > 0 ? 1 : 0,
      maxContextFill: quality.maxContextFill > 0 ? quality.maxContextFill : null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[${label}] computeSessionQuality threw for session ${sessionId}; persisting neutral flags`,
      err
    );
    return {
      quality: null,
      hasCompactionLoop: 0,
      hasToolFailureStreak: 0,
      maxContextFill: null,
    };
  }
}

// ── DB writers ─────────────────────────────────────────────────────────────

/**
 * #395: persist subagent tool calls, idempotently.
 *
 * `INSERT OR IGNORE` on `(session_id, tool_use_id)` rather than an additive
 * counter, because a session is not always written in one pass:
 * `appendSessionTail` amends it in place as the file grows, and no dedupe state
 * survives between parses. An additive counter would therefore double a tool
 * block re-logged across a window boundary and stay wrong until the next full
 * re-parse; a replacing counter would report only the final window, making a
 * long-running session's subagent work *shrink* as it ran. Keying on the id
 * makes both questions moot — running it twice over the same bytes is a no-op.
 *
 * Returns rows actually inserted (not attempted), for the caller's tally.
 */
function writeSidechainToolUses(
  db: DatabaseT.Database,
  sessionId: string,
  toolUses: Map<string, string>
): number {
  if (toolUses.size === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO sidechain_tool_uses (session_id, tool_use_id, tool_name)
     VALUES (?, ?, ?)`
  );
  let rows = 0;
  for (const [toolUseId, toolName] of toolUses) {
    rows += Number(stmt.run(sessionId, toolUseId, toolName).changes ?? 0);
  }
  return rows;
}

/**
 * Write one parsed session. Caller wraps in a transaction. On a re-parse of
 * an existing session, we DELETE the old session row first (cascading FK
 * deletes wipe children) then INSERT fresh — simpler and more correct than
 * trying to UPDATE-or-INSERT individual children.
 */
function writeSession(db: DatabaseT.Database, s: ParsedSession): number {
  let rows = 0;

  const tDelete = PROFILE ? performance.now() : 0;
  // FTS5 indexes by its internal rowid; filtering on UNINDEXED columns
  // (`session_id`, `turn_index`) forces a full table scan. Doing that
  // scan once per session beats letting the FK cascade fire a per-turn
  // trigger N times (N × scan cost). Caller contract: any code path
  // that deletes turns must clean `prompts_fts` for the session first.
  //
  // Skip both deletes when no row exists — saves the ~125 ms FTS scan
  // for brand-new sessions (cold-start indexing, new project mid-
  // stream). The PK lookup on `sessions` is microseconds.
  const existingSession = db
    .prepare("SELECT 1 FROM sessions WHERE session_id = ?")
    .get(s.sessionId);
  // T2.2: save existing session_prs BEFORE the cascade DELETE wipes them.
  // If `safeExtractPrs` returned `[]` due to a throw on this re-parse (a
  // single content-shape change can take out the whole session's PRs),
  // we restore the prior rows after re-insert — `INSERT OR IGNORE` plus
  // the new-extraction-wins merge means a healthy re-extract still
  // supersedes them. Read review #2.
  let preservedPrs: PrLink[] = [];
  // Same posture for tickets (item 3): the cascade DELETE wipes
  // session_tickets too, so capture the prior rows first and merge them
  // back so a thrown extractor (→ `[]`) on this pass doesn't lose them.
  let preservedTickets: TicketLink[] = [];
  if (existingSession) {
    preservedPrs = (
      db
        .prepare(
          "SELECT pr_url, pr_number, repo, source FROM session_prs WHERE session_id = ?",
        )
        .all(s.sessionId) as Array<{
        pr_url: string;
        pr_number: number;
        repo: string;
        source: string | null;
      }>
    ).map((r) => ({
      url: r.pr_url,
      number: r.pr_number,
      repo: r.repo,
      // NULL here means "indexed before the column existed", not "scraped" —
      // preserve the absence rather than inventing a provenance for it.
      source: toPrLinkSource(r.source),
    }));
    preservedTickets = (
      db
        .prepare(
          "SELECT url, provider, ticket_key FROM session_tickets WHERE session_id = ?",
        )
        .all(s.sessionId) as Array<{
        url: string;
        provider: string;
        ticket_key: string;
      }>
    ).map((r) => ({
      url: r.url,
      provider: r.provider as TicketLink["provider"],
      key: r.ticket_key,
    }));
    db.prepare("DELETE FROM prompts_fts WHERE session_id = ?").run(s.sessionId);
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(s.sessionId);
  }
  if (PROFILE) tick("write.delete", performance.now() - tDelete);

  const tInsertSession = PROFILE ? performance.now() : 0;
  db.prepare(
    `INSERT INTO sessions (
       session_id, project_slug, project_dir_name, file_path,
       file_mtime_ms, file_size, byte_offset,
       start_ts, end_ts, primary_model, status,
       turn_count, user_turn_count, assistant_turn_count,
       tool_call_count, error_count,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       cost_usd, cache_hit_ratio, max_context_fill,
       has_compaction_loop, has_tool_failure_streak,
       has_one_shot, verified_task_count, one_shot_task_count,
       git_branch, initial_prompt, last_prompt, slug,
       has_thinking, cli_version, has_resume_anomaly, compact_boundary_count,
       derived_version, indexed_at_ms,
       work_mode_exploration_pct, work_mode_building_pct,
       work_mode_testing_pct, work_mode_other_pct,
       source, home_key,
       session_kind, ai_title, entrypoint
     ) VALUES (
       @session_id, @project_slug, @project_dir_name, @file_path,
       @file_mtime_ms, @file_size, @byte_offset,
       @start_ts, @end_ts, @primary_model, @status,
       @turn_count, @user_turn_count, @assistant_turn_count,
       @tool_call_count, @error_count,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @cost_usd, @cache_hit_ratio, @max_context_fill,
       @has_compaction_loop, @has_tool_failure_streak,
       @has_one_shot, @verified_task_count, @one_shot_task_count,
       @git_branch, @initial_prompt, @last_prompt, @slug,
       @has_thinking, @cli_version, @has_resume_anomaly, @compact_boundary_count,
       @derived_version, @indexed_at_ms,
       @work_mode_exploration_pct, @work_mode_building_pct,
       @work_mode_testing_pct, @work_mode_other_pct,
       @source, @home_key,
       @session_kind, @ai_title, @entrypoint
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
    status: s.storedStatus,
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
    max_context_fill: s.maxContextFill,
    has_compaction_loop: s.hasCompactionLoop,
    has_tool_failure_streak: s.hasToolFailureStreak,
    has_one_shot: s.hasOneShot,
    verified_task_count: s.verifiedTaskCount,
    one_shot_task_count: s.oneShotTaskCount,
    git_branch: s.gitBranch,
    initial_prompt: s.initialPrompt,
    last_prompt: s.lastPrompt,
    slug: s.slug,
    has_thinking: s.hasThinking,
    cli_version: s.cliVersion,
    has_resume_anomaly: s.hasResumeAnomaly,
    compact_boundary_count: s.compactBoundaryCount,
    derived_version: DERIVED_VERSION,
    indexed_at_ms: Date.now(),
    work_mode_exploration_pct: s.workModeExplorationPct,
    work_mode_building_pct: s.workModeBuildingPct,
    work_mode_testing_pct: s.workModeTestingPct,
    work_mode_other_pct: s.workModeOtherPct,
    source: s.source,
    home_key: s.homeKey,
    session_kind: s.sessionKind,
    ai_title: s.aiTitle,
    entrypoint: s.entrypoint,
  });
  rows++;
  if (PROFILE) tick("write.insertSession", performance.now() - tInsertSession);

  // #395: subagent tool calls. The `DELETE FROM sessions` above cascades these
  // away on a rewrite, so this pass rebuilds them exactly; the same statement
  // serves `appendSessionTail`, which does NOT delete first and relies on the
  // id key to ignore what it has already stored.
  rows += writeSidechainToolUses(db, s.sessionId, s.sidechainToolUses);

  // A1 one-to-many session metadata. DELETE-then-INSERT rather than INSERT OR
  // IGNORE: these have no natural unique key (the same hook command runs many
  // times, and a session can switch to `plan` more than once), so on a re-ingest
  // of the same session an IGNORE would append duplicates instead of replacing.
  // `writeSession` already owns the whole session row, so wiping its children
  // first is consistent with that.
  db.prepare("DELETE FROM session_hook_runs WHERE session_id = ?").run(s.sessionId);
  const insertHookRun = db.prepare(
    "INSERT INTO session_hook_runs (session_id, ts, command, duration_ms) VALUES (?, ?, ?, ?)"
  );
  for (const h of s.hookRuns) {
    insertHookRun.run(s.sessionId, h.ts, h.command, h.durationMs);
    rows++;
  }
  db.prepare("DELETE FROM session_hook_errors WHERE session_id = ?").run(s.sessionId);
  const insertHookError = db.prepare(
    "INSERT INTO session_hook_errors (session_id, ts, message, prevented_continuation) VALUES (?, ?, ?, ?)"
  );
  for (const h of s.hookErrors) {
    insertHookError.run(s.sessionId, h.ts, h.message, h.preventedContinuation ? 1 : 0);
    rows++;
  }
  db.prepare("DELETE FROM session_permission_modes WHERE session_id = ?").run(s.sessionId);
  const insertPermissionMode = db.prepare(
    "INSERT INTO session_permission_modes (session_id, ts, mode) VALUES (?, ?, ?)"
  );
  for (const p of s.permissionModes) {
    insertPermissionMode.run(s.sessionId, p.ts, p.mode);
    rows++;
  }

  const insertTurn = db.prepare(
    `INSERT INTO turns (
       session_id, turn_index, ts, role, model,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       context_fill, is_error, parent_tool_use_id, text_preview, tool_result_preview,
       category, cost_usd,
       turn_duration_ms, has_thinking, text_offset, is_sidechain,
       effort, attribution_skill, attribution_mcp_server, attribution_mcp_tool,
       task_outcome, request_id,
       derived_version
     ) VALUES (
       @session_id, @turn_index, @ts, @role, @model,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @context_fill, @is_error, @parent_tool_use_id, @text_preview, @tool_result_preview,
       @category, @cost_usd,
       @turn_duration_ms, @has_thinking, @text_offset, @is_sidechain,
       @effort, @attribution_skill, @attribution_mcp_server, @attribution_mcp_tool,
       @task_outcome, @request_id,
       @derived_version
     )`
  );
  const insertFtsChunk = db.prepare(INSERT_FTS_CHUNK_SQL);
  const insertToolUse = db.prepare(
    `INSERT INTO tool_uses (
       session_id, turn_index, sequence_in_turn, tool_use_id, ts, tool_name,
       mcp_server, mcp_tool, agent_name, skill_name,
       arguments_json, file_path, file_op, is_error,
       error_category, invocation_source, denial_kind
     ) VALUES (
       @session_id, @turn_index, @sequence_in_turn, @tool_use_id, @ts, @tool_name,
       @mcp_server, @mcp_tool, @agent_name, @skill_name,
       @arguments_json, @file_path, @file_op, @is_error,
       @error_category, @invocation_source, @denial_kind
     )`
  );
  const insertFileEdit = db.prepare(
    `INSERT OR IGNORE INTO file_edits (session_id, turn_index, file_path, op, ts)
     VALUES (?, ?, ?, ?, ?)`
  );
  // A5 + Codex review: PROMOTE-ONLY upsert, not INSERT OR IGNORE.
  //
  // Live indexing persists the scraped `gh pr create` result the moment it is
  // parsed. Claude Code appends its authoritative `pr-link` entry afterwards,
  // so on the next tail the row already exists — and `INSERT OR IGNORE`
  // discarded the upgrade, leaving the DB backend reporting the link as
  // `scraped` forever while a full file parse called it `recorded`. A silent
  // backend divergence, on a field whose entire purpose is to say which source
  // to trust.
  //
  // The CASE guards make it promote-only: a later scraped row can never demote
  // a recorded one, which matters because both readers emit both sources on
  // every pass and their order is not guaranteed. `pr_number` is never updated
  // — it is part of the identity, not a mutable attribute.
  const insertSessionPr = db.prepare(
    `INSERT INTO session_prs (session_id, pr_url, pr_number, repo, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, pr_url) DO UPDATE SET
       source = 'recorded',
       repo   = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE session_prs.repo END
     WHERE excluded.source = 'recorded'
       AND (session_prs.source IS NOT 'recorded'
            OR (excluded.repo <> '' AND session_prs.repo IS NOT excluded.repo))`
  );
  const insertSessionTicket = db.prepare(
    `INSERT OR IGNORE INTO session_tickets (session_id, url, provider, ticket_key)
     VALUES (?, ?, ?, ?)`
  );

  // Persist PRs found by the extractor. The prior `DELETE FROM sessions`
  // (above, when an existing row was found) cascaded through the FK to
  // wipe stale entries — but `preservedPrs` captured the prior set first
  // so a thrown extractor (returning `[]` via `safeExtractPrs`) doesn't
  // destroy data. Fresh extraction takes precedence on URL dedup; the
  // preserved set fills the gap when extraction returned empty. Counter
  // uses `result.changes` so INSERT OR IGNORE NOOPs don't inflate the
  // soak-monitoring `rowsWritten` metric. Read review #2 and #6.
  //
  // The promote-only rule moved from the SET expressions into a conflict
  // `WHERE` for that same metric. `DO UPDATE` reports `changes = 1` whenever it
  // fires, and the old `CASE` form fired on every conflicting row — writing the
  // existing value back to itself and counting it. Re-scanning a transcript
  // then reported every historical PR as newly written, which matters most in
  // `recoverStraddledPrs`: it upserts the whole file whenever a tail holds any
  // orphan tool result (Codex review, #385). With the guard the statement is a
  // genuine no-op when nothing would change, so the counters mean what they say.
  for (const pr of mergePrLinks(s.prs, preservedPrs)) {
    const result = insertSessionPr.run(s.sessionId, pr.url, pr.number, pr.repo, pr.source ?? null);
    rows += Number(result.changes ?? 0);
  }
  // Tickets: same preserve-then-merge as PRs (item 3).
  for (const t of mergeTicketLinks(s.tickets, preservedTickets)) {
    const result = insertSessionTicket.run(s.sessionId, t.url, t.provider, t.key);
    rows += Number(result.changes ?? 0);
  }

  const tInsertChildren = PROFILE ? performance.now() : 0;
  for (const t of s.turns) {
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
      context_fill: t.contextFill,
      is_error: t.isError,
      parent_tool_use_id: t.parentToolUseId,
      text_preview: t.textPreview,
      tool_result_preview: t.toolResultPreview,
      category: t.category,
      cost_usd: t.costUsd,
      turn_duration_ms: t.turnDurationMs,
      has_thinking: t.hasThinking,
      text_offset: t.textOffset,
      is_sidechain: t.isSidechain,
      // A1. `?? null` is required, not cosmetic: better-sqlite3 throws on an
      // `undefined` named parameter rather than binding NULL, and every one of
      // these is absent on pre-2.1.212 transcripts.
      // `|| null`, not `?? null`: an empty-string effort is not a reasoning
      // level, and `effortBucket("")` maps it to `unknown` on the file
      // backend. Storing `''` would make the two backends bucket the same
      // turn differently (Codex review, PR #378). The read paths normalize
      // too, so pre-existing `''` rows are handled without a re-parse.
      effort: t.effort || null,
      attribution_skill: t.attributionSkill ?? null,
      attribution_mcp_server: t.attributionMcpServer ?? null,
      attribution_mcp_tool: t.attributionMcpTool ?? null,
      // A2. NULL means "started no verified task" — the common case — not
      // "failed"; see the schema.sql note on turns.task_outcome.
      task_outcome: t.taskOutcome ?? null,
      request_id: t.requestId ?? null,
      derived_version: DERIVED_VERSION,
    });
    rows++;
    rows += insertTurnChunks(insertFtsChunk, s.sessionId, t);

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
        error_category: tu.errorCategory,
        invocation_source: tu.invocationSource,
        denial_kind: tu.denialKind,
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
  if (PROFILE) tick("write.insertChildren", performance.now() - tInsertChildren);

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
  // Sum the per-turn `cost_usd` that ingest already stamped, rather than
  // re-pricing from the token columns. Both `INSERT INTO turns` statements
  // write that column and `sessions.cost_usd` is the same sum, so this is the
  // authoritative figure — and re-deriving here would now *diverge* from it,
  // because pricing needs the cache-TTL split (1-hour writes bill at 2x, not
  // 1.25x) and that split is not persisted as a token column. The older note
  // here said cost "can't be summed in pure SQL because pricing is held in
  // JS"; that stopped being true when `turns.cost_usd` landed in schema v3.
  const fetchCostStmt = db.prepare(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS cost, COUNT(*) AS turnCount
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
    const row = fetchCostStmt.get(model, projectSlug, day) as {
      cost: number;
      turnCount: number;
    };
    if (row.turnCount > 0) {
      updateCostStmt.run(row.cost, day, projectSlug, model);
    }
  }

  refreshAllTuples(tuples);
}

/**
 * Sister to `refreshDailyCosts`, keyed on category instead of model.
 * Recomputes `category_costs` rows for the given (day|project|category)
 * tuples from the source `turns` rows.
 *
 * Pure SQL — no JS pricing pass needed because `turns.cost_usd` was
 * stamped at ingest. That makes this function dramatically simpler than
 * `refreshDailyCosts` (which still exists in its JS-pricing form for
 * backward compatibility).
 *
 * Wrapped in a single transaction so a mid-refresh crash leaves the
 * rollup either fully old or fully new for this batch, never partial.
 */
export function refreshCategoryCosts(db: DatabaseT.Database, tuples: Set<string>): void {
  if (tuples.size === 0) return;
  // Named bindings throughout (vs the positional pattern in
  // `refreshDailyCosts`) — adjacent statements binding the same fields
  // in different orders is a maintenance trap.
  const deleteStmt = db.prepare(
    "DELETE FROM category_costs WHERE day = @day AND project_slug = @projectSlug AND category = @category"
  );
  const insertStmt = db.prepare(
    `INSERT INTO category_costs (day, project_slug, category, turns, tokens, cost_usd)
     SELECT
       substr(t.ts, 1, 10)        AS day,
       s.project_slug             AS project_slug,
       t.category                 AS category,
       COUNT(*)                   AS turns,
       SUM(t.input_tokens + t.output_tokens + t.cache_create_tokens + t.cache_read_tokens) AS tokens,
       SUM(t.cost_usd)            AS cost_usd
     FROM turns t
     JOIN sessions s USING (session_id)
     WHERE t.role = 'assistant'
       AND t.category = @category
       AND s.project_slug = @projectSlug
       AND substr(t.ts, 1, 10) = @day
     GROUP BY day, s.project_slug, t.category`
  );

  const refreshAll = db.transaction((pending: Set<string>) => {
    for (const tuple of pending) {
      const [day, projectSlug, category] = tuple.split("|");
      // Pipe-delimited tuple key matches `affectedDays` shape. Categories
      // are a closed set from `classifyTurn`, none containing `|`.
      const params = { day, projectSlug, category };
      deleteStmt.run(params);
      insertStmt.run(params);
    }
  });

  refreshAll(tuples);
}

// ── Tail-append support ────────────────────────────────────────────────────

/**
 * Rehydrate an existing session's turns as `UsageTurn[]` for re-running
 * `detectOneShot` (and any other classifier that needs the full turn
 * history) over old + new combined. The detector looks at sliding
 * windows of turns — Edit → Bash(test) → re-edit — so a tail append can
 * change the verdict on prior turns. We have to feed it the union, not
 * just the new bytes.
 *
 * Returns the `turn_index` of each row alongside the projection. They are NOT
 * interchangeable with array positions: this query filters `is_sidechain = 0`,
 * so any subagent turn in the session punches a hole in the numbering. A2's
 * `task_outcome` write-back needs the real index to target the right row.
 */
function loadExistingTurnsAsUsage(
  db: DatabaseT.Database,
  sessionId: string,
  projectSlug: string,
  projectDirName: string
): { usageTurns: UsageTurn[]; turnIndexes: number[] } {
  // `is_sidechain = 0`: one-shot / quality detectors run over primary turns
  // only (see the turns.is_sidechain schema note). This is the tail path's
  // only caller; the full-replace path runs the same detectors over its
  // primary parsed turns, so filtering here keeps the two paths in parity now
  // that sidechain turns are persisted as rows.
  const turnRows = db
    .prepare(
      `SELECT turn_index, ts, role, model,
              input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
              is_error, text_preview, tool_result_preview
       FROM turns WHERE session_id = ? AND is_sidechain = 0 ORDER BY turn_index`
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

  if (turnRows.length === 0) return { usageTurns: [], turnIndexes: [] };

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

  const usageTurns = turnRows.map((r): UsageTurn => ({
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
    assistantText: r.role === "assistant" ? (r.text_preview ?? undefined) : undefined,
  }));

  return { usageTurns, turnIndexes: turnRows.map((r) => r.turn_index) };
}

/**
 * Rewrite `turns.task_outcome` for a whole session from a fresh detector run.
 *
 * Clears first, then stamps. The clear is the part that matters: after a tail
 * append a turn that previously anchored a task may no longer anchor one (its
 * verification moved, or a later edit absorbed it), and stamping alone would
 * leave the stale verdict behind forever — a row claiming a first-pass success
 * for a task that no longer exists.
 *
 * Scoped to `is_sidechain = 0` to match the rows the detector was given. BOTH
 * statements carry the guard. Today `turnIndexes` can only contain primary
 * indices — `loadExistingTurnsAsUsage` filters on the same clause — so the
 * stamp could rely on its caller instead. It doesn't, because that is an
 * invariant held three functions away from the write: a later change to how
 * turns are selected would silently start stamping outcomes onto subagent
 * rows, which are excluded from every one-shot read and would then be
 * unreachable-but-wrong.
 */
function rewriteTaskOutcomes(
  db: DatabaseT.Database,
  sessionId: string,
  tasks: OneShotTask[],
  turnIndexes: number[]
): void {
  db.prepare(
    "UPDATE turns SET task_outcome = NULL WHERE session_id = ? AND is_sidechain = 0 AND task_outcome IS NOT NULL"
  ).run(sessionId);
  const stamp = db.prepare(
    "UPDATE turns SET task_outcome = ? WHERE session_id = ? AND turn_index = ? AND is_sidechain = 0"
  );
  for (const task of tasks) {
    const turnIndex = turnIndexes[task.anchorIndex];
    if (turnIndex === undefined) continue;
    stamp.run(task.oneShot ? "one_shot" : "retry", sessionId, turnIndex);
  }
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
): { rows: number; affectedDays: Set<string>; affectedCategoryTuples: Set<string> } {
  let rows = 0;
  const sessionId = parsed.sessionId;

  // Insert just the new rows. Reuse the writer prepares from writeSession-
  // style inserts but skip the DELETE FROM sessions step — we're amending,
  // not replacing.
  const insertTurn = db.prepare(
    `INSERT INTO turns (
       session_id, turn_index, ts, role, model,
       input_tokens, output_tokens, cache_create_tokens, cache_read_tokens,
       context_fill, is_error, parent_tool_use_id, text_preview, tool_result_preview,
       category, cost_usd,
       turn_duration_ms, has_thinking, text_offset, is_sidechain,
       effort, attribution_skill, attribution_mcp_server, attribution_mcp_tool,
       task_outcome, request_id,
       derived_version
     ) VALUES (
       @session_id, @turn_index, @ts, @role, @model,
       @input_tokens, @output_tokens, @cache_create_tokens, @cache_read_tokens,
       @context_fill, @is_error, @parent_tool_use_id, @text_preview, @tool_result_preview,
       @category, @cost_usd,
       @turn_duration_ms, @has_thinking, @text_offset, @is_sidechain,
       @effort, @attribution_skill, @attribution_mcp_server, @attribution_mcp_tool,
       @task_outcome, @request_id,
       @derived_version
     )`
  );
  const insertFtsChunk = db.prepare(INSERT_FTS_CHUNK_SQL);
  const insertToolUse = db.prepare(
    `INSERT INTO tool_uses (
       session_id, turn_index, sequence_in_turn, tool_use_id, ts, tool_name,
       mcp_server, mcp_tool, agent_name, skill_name,
       arguments_json, file_path, file_op, is_error,
       error_category, invocation_source, denial_kind
     ) VALUES (
       @session_id, @turn_index, @sequence_in_turn, @tool_use_id, @ts, @tool_name,
       @mcp_server, @mcp_tool, @agent_name, @skill_name,
       @arguments_json, @file_path, @file_op, @is_error,
       @error_category, @invocation_source, @denial_kind
     )`
  );
  const insertFileEdit = db.prepare(
    `INSERT OR IGNORE INTO file_edits (session_id, turn_index, file_path, op, ts)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertSessionPr = db.prepare(
    `INSERT INTO session_prs (session_id, pr_url, pr_number, repo, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, pr_url) DO UPDATE SET
       source = 'recorded',
       repo   = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE session_prs.repo END
     WHERE excluded.source = 'recorded'
       AND (session_prs.source IS NOT 'recorded'
            OR (excluded.repo <> '' AND session_prs.repo IS NOT excluded.repo))`
  );
  const insertSessionTicket = db.prepare(
    `INSERT OR IGNORE INTO session_tickets (session_id, url, provider, ticket_key)
     VALUES (?, ?, ?, ?)`
  );

  // T2.2: tail-parse only sees entries past the byte cursor. The straddle
  // case (call before cursor, result after) is recovered by a second
  // full-file pass below — see `recoverStraddledPrs`. Counter uses
  // `result.changes` so INSERT OR IGNORE NOOPs (PRs already persisted by
  // the prior writeSession) don't inflate the soak-monitoring metric.
  // Read review #1 and #6.
  for (const pr of parsed.prs) {
    const result = insertSessionPr.run(sessionId, pr.url, pr.number, pr.repo, pr.source ?? null);
    rows += Number(result.changes ?? 0);
  }
  // Tickets: no straddle case to recover — they come from a plain text
  // scan, not a call→result pairing. A tail-append re-finds tickets only
  // in the new bytes; older ones already persisted by the prior
  // writeSession survive via INSERT OR IGNORE.
  for (const t of parsed.tickets) {
    const result = insertSessionTicket.run(sessionId, t.url, t.provider, t.key);
    rows += Number(result.changes ?? 0);
  }

  // #395: this window's subagent tool calls join whatever earlier windows
  // recorded. Keyed on `tool_use_id`, so a call re-logged across the boundary
  // between two windows settles to one row rather than being counted twice —
  // see `writeSidechainToolUses`.
  rows += writeSidechainToolUses(db, sessionId, parsed.sidechainToolUses);

  for (const t of parsed.turns) {
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
      context_fill: t.contextFill,
      is_error: t.isError,
      parent_tool_use_id: t.parentToolUseId,
      text_preview: t.textPreview,
      tool_result_preview: t.toolResultPreview,
      category: t.category,
      cost_usd: t.costUsd,
      turn_duration_ms: t.turnDurationMs,
      has_thinking: t.hasThinking,
      text_offset: t.textOffset,
      is_sidechain: t.isSidechain,
      // A1. `?? null` is required, not cosmetic: better-sqlite3 throws on an
      // `undefined` named parameter rather than binding NULL, and every one of
      // these is absent on pre-2.1.212 transcripts.
      // `|| null`, not `?? null`: an empty-string effort is not a reasoning
      // level, and `effortBucket("")` maps it to `unknown` on the file
      // backend. Storing `''` would make the two backends bucket the same
      // turn differently (Codex review, PR #378). The read paths normalize
      // too, so pre-existing `''` rows are handled without a re-parse.
      effort: t.effort || null,
      attribution_skill: t.attributionSkill ?? null,
      attribution_mcp_server: t.attributionMcpServer ?? null,
      attribution_mcp_tool: t.attributionMcpTool ?? null,
      // A2. NULL means "started no verified task" — the common case — not
      // "failed"; see the schema.sql note on turns.task_outcome.
      task_outcome: t.taskOutcome ?? null,
      request_id: t.requestId ?? null,
      derived_version: DERIVED_VERSION,
    });
    rows++;
    rows += insertTurnChunks(insertFtsChunk, sessionId, t);

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
        error_category: tu.errorCategory,
        invocation_source: tu.invocationSource,
        denial_kind: tu.denialKind,
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
  // cost_usd folds in via SUM(turns.cost_usd) — no second JS pricing
  // pass since each turn's cost was stamped at insert.
  //
  // `is_sidechain = 0`: the session-row aggregates are primary-only, matching
  // the full-replace path (writeSession derives them from `primaryTurnCount`
  // captured before appending sidechain rows). Without this filter a tail
  // append that carries sidechain assistant rows would inflate the session's
  // turn_count / assistant_turn_count / cost_usd / token totals with subagent
  // work. Sidechain cost still folds into the usage totals — those roll up
  // over the daily_costs / category_costs derivation below, which is NOT
  // filtered here.
  // COALESCE every SUM: SQL's SUM over zero rows is NULL (only COUNT is
  // zero-safe), and a sidechain-only session — e.g. a `subagents/agent-*.jsonl`
  // transcript, whose rows are ALL is_sidechain=1 — matches zero rows here.
  // Without the COALESCE the UPDATE below would write NULL into NOT NULL
  // columns (user_turn_count etc.), the transaction would roll back, the
  // cursor would never advance, and every append would retry-fail forever.
  const aggRow = db
    .prepare(
      `SELECT
         COUNT(*) AS turn_count,
         COALESCE(SUM(CASE WHEN role='user'      THEN 1 ELSE 0 END), 0) AS user_turn_count,
         COALESCE(SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END), 0) AS assistant_turn_count,
         COALESCE(SUM(is_error), 0)            AS error_count,
         COALESCE(SUM(input_tokens), 0)        AS input_tokens,
         COALESCE(SUM(output_tokens), 0)       AS output_tokens,
         COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
         COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
         SUM(cost_usd)            AS cost_usd,
         MIN(ts) AS start_ts,
         MAX(ts) AS end_ts
       FROM turns WHERE session_id = ? AND is_sidechain = 0`
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
    cost_usd: number | null;
    start_ts: string | null;
    end_ts: string | null;
  };

  const toolCallCount = (db
    .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = ?")
    .get(sessionId) as { n: number }).n;

  const modelRow = db
    .prepare(
      `SELECT model, COUNT(*) AS n FROM turns
       WHERE session_id = ? AND role='assistant' AND model IS NOT NULL AND is_sidechain = 0
       GROUP BY model ORDER BY n DESC LIMIT 1`
    )
    .get(sessionId) as { model: string; n: number } | undefined;
  const primaryModel = modelRow?.model ?? null;

  const costUsd = aggRow.cost_usd ?? 0;

  // Sidechain-only session: the primary-filtered MIN/MAX above found no rows,
  // so fall back to time bounds over ALL turns — otherwise the session keeps
  // NULL start/end and sorts to the bottom of every time-ordered surface.
  // Primary sessions keep their primary-only bounds (unchanged semantics).
  if (aggRow.start_ts === null) {
    const allBounds = db
      .prepare("SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts FROM turns WHERE session_id = ?")
      .get(sessionId) as { start_ts: string | null; end_ts: string | null };
    aggRow.start_ts = allBounds.start_ts;
    aggRow.end_ts = allBounds.end_ts;
  }

  // One-shot detection over old + new combined.
  const { usageTurns: allUsageTurns, turnIndexes } = loadExistingTurnsAsUsage(
    db,
    sessionId,
    parsed.projectSlug,
    parsed.projectDirName
  );
  const tailTasks = detectOneShotTasks(allUsageTurns);
  const oneShot = summarizeOneShotTasks(tailTasks);
  const hasOneShot: 0 | 1 = oneShot.oneShotTasks > 0 ? 1 : 0;
  // A2: re-stamp the whole session, not just the appended rows. The rows the
  // tail INSERTed above carried outcomes computed from the tail window alone,
  // which could not see the edit a straddling task started in earlier bytes —
  // and a prior turn's verdict can flip when the tail adds the re-edit that
  // makes it a retry. Only a rewrite over the union is correct.
  rewriteTaskOutcomes(db, sessionId, tailTasks, turnIndexes);

  // Quality flags: re-run detectors over the union of old + new turns. New
  // turns are already inserted at this point so `allUsageTurns` covers them.
  // Detectors are stateless re-scans; positive flags persist between
  // appends because the historical evaluable turns don't disappear, but
  // they can theoretically clear when a streak's center moves out of its
  // window or a compaction-loop run gets absorbed into a larger one.
  const tQualityTail = PROFILE ? performance.now() : 0;
  const { quality: tailQuality, hasCompactionLoop, hasToolFailureStreak, maxContextFill } =
    safeComputeQuality(allUsageTurns, sessionId, "ingest tail");
  // Cache hit ratio mirrors the full-INSERT fallback: prefer the
  // detector's output, otherwise compute from the SUM aggregate.
  const cacheHitRatio =
    tailQuality?.cache.hitRatio ??
    (aggRow.cache_create_tokens + aggRow.cache_read_tokens > 0
      ? aggRow.cache_read_tokens / (aggRow.cache_create_tokens + aggRow.cache_read_tokens)
      : null);
  if (PROFILE) tick("sessionQualityTail", performance.now() - tQualityTail);

  // last_prompt: prefer the human prompt parsed from the tail. If the
  // tail was assistant-only (no new human prompt), keep whatever the
  // session already had — `initial_prompt` is the WRONG fallback,
  // it'd regress a multi-prompt session's last prompt back to its
  // first one on the first assistant-only append.
  const promptRow = db
    .prepare("SELECT last_prompt FROM sessions WHERE session_id = ?")
    .get(sessionId) as { last_prompt: string | null } | undefined;
  const lastPrompt = parsed.lastPrompt ?? promptRow?.last_prompt ?? null;

  // Status update on tail: only refresh when the tail itself contained
  // an assistant turn (`assistantTurnCount > 0` in `parsed`). Reasoning:
  //   - Tail with assistant turn: the tail's `storedStatus` correctly
  //     reflects the new "last assistant" + any subsequent tail user
  //     turn resolutions.
  //   - Tail with only user turns: `storedStatus` would be `'inactive'`
  //     because no `sawAnyAssistant` in the tail, but the actual state
  //     is "prior pendings minus any resolved by this tail" — and we
  //     don't have the prior pending IDs cached. Conservatively keep
  //     the previous status; let the next full reconcile correct it.
  // Documented staleness window: a `'waiting'` session whose pendings
  // are all resolved via tail-only user turns will keep showing as
  // `'waiting'` (and time-gate to `working / needs_attention / idle`
  // depending on file mtime) until the next process restart triggers a
  // full reconcile. Acceptable trade-off for the ~150-session corpus.
  // Recompute work-mode over all turns (old + new) now that new turns are inserted.
  const allCategoryRows = db
    .prepare("SELECT category FROM turns WHERE session_id = ? AND role = 'assistant' AND is_sidechain = 0")
    .all(sessionId) as Array<{ category: string | null }>;
  const tailWorkMode = aggregateWorkMode(allCategoryRows);

  const refreshStatus = parsed.assistantTurnCount > 0;
  const statusUpdateClause = refreshStatus ? "status = @status, " : "";
  const statusUpdateParam = refreshStatus ? { status: parsed.storedStatus } : {};

  db.prepare(
    `UPDATE sessions SET
       file_path           = @file_path,
       file_mtime_ms       = @file_mtime_ms,
       file_size           = @file_size,
       byte_offset         = @byte_offset,
       start_ts            = @start_ts,
       end_ts              = @end_ts,
       primary_model       = @primary_model,
       slug                = COALESCE(slug, @slug),
       ${statusUpdateClause}turn_count          = @turn_count,
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
       max_context_fill    = @max_context_fill,
       has_compaction_loop = @has_compaction_loop,
       has_tool_failure_streak = @has_tool_failure_streak,
       has_one_shot        = @has_one_shot,
       verified_task_count = @verified_task_count,
       one_shot_task_count = @one_shot_task_count,
       last_prompt         = @last_prompt,
       indexed_at_ms       = @indexed_at_ms,
       work_mode_exploration_pct = @work_mode_exploration_pct,
       work_mode_building_pct = @work_mode_building_pct,
       work_mode_testing_pct  = @work_mode_testing_pct,
       work_mode_other_pct    = @work_mode_other_pct,
       source                 = @source,
       -- A1. Two different merge rules, because the fields mean different things:
       --   session_kind / entrypoint are CONSTANT for a session, so the stored
       --     value wins and a tail that did not happen to include an attachment
       --     cannot blank them (same shape as the slug clause above).
       --   ai_title is RE-EMITTED as the session subject clarifies, so the
       --     newest non-null wins -- note the reversed COALESCE argument order.
       session_kind = COALESCE(session_kind, @session_kind),
       entrypoint   = COALESCE(entrypoint, @entrypoint),
       ai_title     = COALESCE(@ai_title, ai_title)
     WHERE session_id = @session_id`
  ).run({
    ...statusUpdateParam,
    slug: parsed.slug,
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
    max_context_fill: maxContextFill,
    has_compaction_loop: hasCompactionLoop,
    has_tool_failure_streak: hasToolFailureStreak,
    has_one_shot: hasOneShot,
    verified_task_count: oneShot.totalVerifiedTasks,
    one_shot_task_count: oneShot.oneShotTasks,
    last_prompt: lastPrompt,
    indexed_at_ms: Date.now(),
    work_mode_exploration_pct: tailWorkMode.exploration,
    work_mode_building_pct: tailWorkMode.building,
    work_mode_testing_pct: tailWorkMode.testing,
    work_mode_other_pct: tailWorkMode.other,
    source: parsed.source,
    session_kind: parsed.sessionKind,
    entrypoint: parsed.entrypoint,
    ai_title: parsed.aiTitle,
  });
  rows++;

  // A1 one-to-many metadata. APPEND, unlike `writeSession`'s delete-then-insert:
  // a tail window holds only the newly-read bytes, so wiping first would discard
  // every hook run and mode switch from earlier in the session. Rows already
  // persisted stay put and the tail's are added after them, which is also why
  // the read side orders by `rowid` — it is the only thing preserving file order
  // across the append boundary.
  if (parsed.hookRuns.length > 0) {
    const insertHookRun = db.prepare(
      "INSERT INTO session_hook_runs (session_id, ts, command, duration_ms) VALUES (?, ?, ?, ?)"
    );
    for (const h of parsed.hookRuns) {
      insertHookRun.run(sessionId, h.ts, h.command, h.durationMs);
      rows++;
    }
  }
  if (parsed.hookErrors.length > 0) {
    const insertHookError = db.prepare(
      "INSERT INTO session_hook_errors (session_id, ts, message, prevented_continuation) VALUES (?, ?, ?, ?)"
    );
    for (const h of parsed.hookErrors) {
      insertHookError.run(sessionId, h.ts, h.message, h.preventedContinuation ? 1 : 0);
      rows++;
    }
  }
  if (parsed.permissionModes.length > 0) {
    const insertPermissionMode = db.prepare(
      "INSERT INTO session_permission_modes (session_id, ts, mode) VALUES (?, ?, ?)"
    );
    for (const p of parsed.permissionModes) {
      insertPermissionMode.run(sessionId, p.ts, p.mode);
      rows++;
    }
  }

  // Emit just the new turns' tuples. On a tail, prior days/categories
  // are unchanged in `turns`, so re-deriving their rollup rows would be
  // a no-op refresh. `parsed.affectedDays` / `parsed.affectedCategoryTuples`
  // were built in `readJsonlSession` over precisely the new-turn slice.
  return {
    rows,
    affectedDays: parsed.affectedDays,
    affectedCategoryTuples: parsed.affectedCategoryTuples,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Override the projects root for tests. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** Force re-parse of every session, ignoring the mtime/size + version gate. */
  force?: boolean;
  /**
   * Resolved Minder config, used to enumerate enabled harness adapters for
   * the non-Claude ingest pass. Defaults to `readConfig()`. Tests inject this
   * to control `enabledAdapters` without touching `.minder.json`.
   */
  config?: MinderConfig;
  /**
   * Test seam: override the discovered non-Claude session files. Defaults to
   * `discoverAllSessions(config)` minus Claude. Lets tests drive the adapter
   * pass with fixtures instead of the real `~/.codex` / `~/.gemini` homes.
   */
  adapterSessions?: SessionFile[];
  /**
   * Test seam: override how a `SessionFile` is parsed into `UsageTurn[]`.
   * Defaults to the registered adapter's `parseFile`. Lets tests supply
   * canned turns without a real adapter or filesystem.
   */
  parseAdapterFile?: (file: SessionFile) => Promise<UsageTurn[]>;
  /**
   * Record this pass in `indexer_runs`, so another process can tell whether the
   * index has ever been read through (#470).
   *
   * Opt-in, and that is load-bearing: the watcher re-runs `reconcileAllSessions`
   * on a 30 s sweep for the life of the process, so recording unconditionally
   * would write a row every half minute forever and make any "is a pass running"
   * reading flap. Only the INITIAL pass — the one whose completion actually
   * changes what the index can answer — passes this.
   *
   * **Tests that intend to read through `@/lib/data` must pass it too.** The
   * cross-corpus aggregates there gate on `getIndexBuildState` (#472), so a
   * test that seeds its index without this produces something production never
   * does — a corpus that HAS been read through with no evidence of it — and the
   * façade correctly serves file-parse instead. The failure then surfaces as a
   * backend-parity divergence rather than as "the index was not ready", which
   * is the same trap `tests/_helpers/reconcile.ts` documents for the v3 gate.
   */
  recordRun?: IndexerRunKind;
}

export interface FileReconcileResult {
  /** Row count written across sessions/turns/tool_uses/file_edits. 0 = skipped. */
  rowsWritten: number;
  /** (day|project|model) tuples whose daily_costs row needs recomputing. */
  affectedDays: Set<string>;
  /** (day|project|category) tuples whose category_costs row needs recomputing. */
  affectedCategoryTuples: Set<string>;
  /**
   * Set when the file was left alone because its stored rows outrank this
   * build ({@link isNewerDerivation}). Distinct from an ordinary no-op skip:
   * that one means "already up to date", this one means "your binary is
   * behind your index", which is worth surfacing rather than inferring from
   * a `rowsWritten: 0` that looks identical to the healthy case.
   */
  skippedNewerDerivation?: boolean;
}

/**
 * Reconcile a single JSONL file into the DB. Caller is responsible for
 * `loadPricing()` having completed first AND for refreshing daily_costs +
 * category_costs with the returned tuple sets (batched at the end of a
 * multi-file reconcile to avoid recomputing the same tuple N times).
 */
export async function reconcileSessionFile(
  db: DatabaseT.Database,
  filePath: string,
  projectDirName: string,
  options: { force?: boolean } = {}
): Promise<FileReconcileResult> {
  const empty: FileReconcileResult = {
    rowsWritten: 0,
    affectedDays: new Set(),
    affectedCategoryTuples: new Set(),
  };
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
  // The row stores the CANONICAL dir name (worktree dirs collapse to their
  // parent project) — canonicalize before comparing or every worktree file
  // would look mispinned and full-replace on each sweep.
  const canonicalDirName = canonicalizeDirName(projectDirName);
  let existing:
    | {
        file_path: string;
        project_dir_name: string;
        file_mtime_ms: number;
        file_size: number;
        byte_offset: number;
        derived_version: number;
      }
    | undefined;
  if (!options.force) {
    existing = db
      .prepare(
        "SELECT file_path, project_dir_name, file_mtime_ms, file_size, byte_offset, derived_version FROM sessions WHERE session_id = ?"
      )
      .get(sessionId) as typeof existing;

    // Newer-derivation guard, checked BEFORE the unchanged-file gate below
    // and before the tail/full-replace decision that follows. Position is
    // load-bearing: the unchanged-file gate only fires when mtime AND size
    // both match, so a session that merely GREW slipped past it, failed
    // `derived_version === DERIVED_VERSION`, and fell through to a
    // full-replace — which is precisely the path that rewrote v14 rows as
    // v12. Guarding only the no-op gate would have left that hole open.
    if (existing && isNewerDerivation(existing.derived_version)) {
      return { ...empty, skippedNewerDerivation: true };
    }

    if (
      existing &&
      existing.file_path === filePath &&
      existing.project_dir_name === canonicalDirName &&
      existing.file_mtime_ms === mtimeMs &&
      existing.file_size === size &&
      existing.derived_version === DERIVED_VERSION
    ) {
      return empty;
    }
    // Past the gate with an out-of-date stamp: this row is about to be
    // rewritten under the current formula while its neighbours still carry the
    // old one. THAT is where the mixture starts, and it is the moment the
    // aggregates have to start diverting (#478). Announced here rather than
    // inferred from a scan, because a scan running seconds earlier legitimately
    // saw a uniform index.
    if (existing && existing.derived_version < DERIVED_VERSION) {
      markDerivationChanged();
    }
  }

  // Decide between tail-append and full-replace. The tail path is only
  // safe when the file grew at the end with no prefix changes, the path
  // is the same, and the derivation version matches what the existing
  // rows were stamped with. Anything else means our cursor is invalid
  // and we have to re-parse from scratch.
  // `project_dir_name` mismatch also forces a full replace: rows written
  // before the subagent-path fix were mispinned to a literal "subagents"
  // project (the watcher derived the project from the file's immediate
  // parent dir). The tail path never rewrites attribution columns, so a
  // full replace is the self-heal that re-stamps project_dir_name /
  // project_slug and re-derives the rollup tuples under the right slug.
  const canTail =
    !options.force &&
    existing !== undefined &&
    existing.file_path === filePath &&
    existing.project_dir_name === canonicalDirName &&
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
    let affectedCategoryTuples = new Set<string>();
    const txn = db.transaction(() => {
      const result = appendSessionTail(db, tailParsed, mtimeMs, size);
      rows = result.rows;
      affectedDays = result.affectedDays;
      affectedCategoryTuples = result.affectedCategoryTuples;
    });
    txn();

    // T2.2 straddle-recovery (review #1). When the tail contains a
    // `tool_result` whose `tool_use_id` lives in the already-persisted
    // prefix, the tail extractor can't match the pair on its own —
    // bashPrCalls in `safeExtractPrs` only ever sees the tail window. Do
    // a fallback full-file PR pass and INSERT OR IGNORE so the chip
    // appears without waiting on the next DERIVED_VERSION bump. The
    // orphan-result flag was computed cheaply during the tail parse so we
    // skip this whole branch on the common case (no orphan = nothing to
    // recover). Logs and returns soft on any error — never blocks the
    // tail-append's primary correctness.
    let recovered = 0;
    if (tailResult.hasOrphanToolResults) {
      recovered = await recoverStraddledPrs(db, filePath, sessionId);
      if (recovered > 0) rows += recovered;
    }

    if (rows > 0) {
      const slug = projectSlugFromDirName(projectDirName);
      bridgeJsonlAppendToEventBus(sessionId, slug);
      // Signal SSE clients so the live sessions list invalidates (replaces the
      // 15s poll when the liveEvents flag is on). Coalesced server-side.
      emitMinderEvent("sessions.changed");
    }
    return { rowsWritten: rows, affectedDays, affectedCategoryTuples };
  }

  // Full replace path. Collect tuples the OLD session contributed to so a
  // turn that moves between days/models / categories doesn't leave a stale
  // daily_costs / category_costs row behind; union with the new tuples
  // for the refresh.
  const oldTuples = collectExistingDailyTuples(db, sessionId);
  const oldCategoryTuples = collectExistingCategoryTuples(db, sessionId);

  const fullResult = await readJsonlSession(filePath, projectDirName, mtimeMs, size);
  if (!fullResult || !fullResult.parsed) return empty;

  let rows = 0;
  const txn = db.transaction(() => {
    rows = writeSession(db, fullResult.parsed!);
  });
  const tWrite = PROFILE ? performance.now() : 0;
  txn();
  if (PROFILE) tick("writeSession", performance.now() - tWrite);
  const affectedDays = new Set<string>(fullResult.parsed.affectedDays);
  for (const tuple of oldTuples) affectedDays.add(tuple);
  const affectedCategoryTuples = new Set<string>(fullResult.parsed.affectedCategoryTuples);
  for (const tuple of oldCategoryTuples) affectedCategoryTuples.add(tuple);
  if (rows > 0) {
    const slug = projectSlugFromDirName(projectDirName);
    bridgeJsonlAppendToEventBus(sessionId, slug);
  }
  return { rowsWritten: rows, affectedDays, affectedCategoryTuples };
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
 * Sister to `collectExistingDailyTuples`, keyed on category. When the
 * classifier version bumps (via `DERIVED_VERSION`), a turn's category can
 * move on re-parse — without unioning OLD + NEW (day, project, category)
 * tuples, the row keyed on the OLD category goes stale in
 * `category_costs`. Same shape as the daily flow on purpose.
 */
function collectExistingCategoryTuples(db: DatabaseT.Database, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.category AS category
       FROM turns t JOIN sessions s USING (session_id)
       WHERE t.session_id = ? AND t.role = 'assistant' AND t.category IS NOT NULL`
    )
    .all(sessionId) as Array<{ day: string; project_slug: string; category: string }>;
  const tuples = new Set<string>();
  for (const r of rows) tuples.add(`${r.day}|${r.project_slug}|${r.category}`);
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
/**
 * Build a {@link ParsedSession} from a non-Claude harness adapter's
 * `parseFile` output. This is the "lean" ingest path: the `SessionAdapter`
 * contract returns `UsageTurn[]` (a cost/usage projection), which carries less
 * than the rich `ParsedSession` that Claude's raw-JSONL reader produces. So
 * Claude-specific richness that can't be recovered from turns alone (FTS byte
 * offsets, work-mode from raw stream events, PR/ticket harvesting, resume
 * anomaly, compaction-loop detection, per-turn context fill) is left neutral,
 * while everything derivable from the turns themselves is computed with the
 * SAME helpers the Claude path uses — `classifyTurn`, `applyPricing`,
 * `detectOneShot`, `aggregateWorkMode` — so Codex/Gemini sessions get real
 * By-Source / By-Model / By-Project / By-Category / one-shot / work-mode
 * parity, not empty shells.
 *
 * The two identity fixes the keystone requires live here:
 *   - `source` comes from the {@link SessionFile} (never hardcoded "claude").
 *   - `sessionId` comes from the adapter-resolved id carried on the turns
 *     (codex `session_meta.payload.id`, gemini `record.sessionId`), NOT the
 *     filename — so cross-harness sessions can't collide or mis-prune.
 *
 * Returns `null` for an empty session so the caller skips writing a row.
 *
 * Exported for unit testing the conversion in isolation.
 */
export function buildAdapterParsedSession(
  file: SessionFile,
  turns: UsageTurn[],
  fileMtimeMs: number,
  fileSize: number
): ParsedSession | null {
  if (turns.length === 0) return null;

  const sessionId =
    turns.find((t) => t.sessionId)?.sessionId ||
    path.basename(file.filePath).replace(/\.[^.]+$/, "");
  const projectDirName =
    turns.find((t) => t.projectDirName)?.projectDirName || file.projectDirName;
  // The fallback canonicalizes too. Every adapter now stamps a canonical
  // slug on its turns (#497), so a turn-less fallback deriving the raw one
  // would reintroduce the worktree grouping split for exactly the sessions
  // whose turns carry no slug - a narrower hole than the original, and
  // invisible in the common case, which is what makes it worth closing here
  // rather than relying on the adapters alone.
  const projectSlug =
    turns.find((t) => t.projectSlug)?.projectSlug ||
    projectSlugFromDirName(projectDirName);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let userTurnCount = 0;
  let assistantTurnCount = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let startTs: string | null = null;
  let endTs: string | null = null;
  let initialPrompt: string | null = null;
  let lastPrompt: string | null = null;
  const modelCounts = new Map<string, number>();

  const parsedTurns: ParsedTurn[] = turns.map((turn, turnIndex): ParsedTurn => {
    const ts = turn.timestamp;
    if (!startTs || ts < startTs) startTs = ts;
    if (!endTs || ts > endTs) endTs = ts;

    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    cacheCreateTokens += turn.cacheCreateTokens;
    cacheReadTokens += turn.cacheReadTokens;

    const isError: 0 | 1 = turn.isError ? 1 : 0;
    if (isError) errorCount++;

    const toolUses: ParsedToolUse[] = turn.toolCalls.map(
      (tc, sequenceInTurn): ParsedToolUse => {
        const args =
          tc.arguments && typeof tc.arguments === "object"
            ? (tc.arguments as Record<string, unknown>)
            : undefined;
        const mcp = parseMcpTool(tc.name);
        const { filePath: fp, fileOp } = extractFileOp(tc.name, args);
        let argsJson: string | null = null;
        if (args) {
          try {
            argsJson = truncateText(JSON.stringify(args), ARGS_JSON_LIMIT);
          } catch {
            argsJson = null;
          }
        }
        return {
          sequenceInTurn,
          toolUseId: tc.id ?? null,
          toolName: tc.name,
          mcpServer: mcp?.server ?? null,
          mcpTool: mcp?.tool ?? null,
          agentName: extractAgentName(tc.name, args),
          skillName: extractSkillName(tc.name, args),
          argumentsJson: argsJson,
          filePath: fp,
          fileOp,
          isError: tc.isError ? 1 : 0,
          errorCategory: tc.errorCategory ?? null,
          invocationSource: tc.invocationSource ?? "auto",
          // Adapter path (Codex/Gemini): `ToolCall` carries no denial concept,
          // so this is "not reported by this harness" — the same unknown bucket
          // as a Claude transcript predating the field.
          denialKind: null,
        };
      }
    );
    toolCallCount += toolUses.length;

    let category: string | null = null;
    let turnCostUsd = 0;
    let textPreview: string | null;
    let toolResultPreview: string | null = null;

    if (turn.role === "assistant") {
      assistantTurnCount++;
      if (turn.model) modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
      category = classifyTurn({ ...turn, source: file.source });
      if (turn.model) {
        turnCostUsd = applyPricing(getModelPricing(turn.model, turn.speed), turn);
        costUsd += turnCostUsd;
      }
      textPreview = truncateText(turn.assistantText ?? "", TEXT_PREVIEW_LIMIT);
    } else {
      userTurnCount++;
      const userText = turn.userMessageText ?? "";
      toolResultPreview = truncateText(turn.toolResultText ?? "", USAGE_TOOL_RESULT_LIMIT);
      textPreview = truncateText(userText || (turn.toolResultText ?? ""), TEXT_PREVIEW_LIMIT);
      // Track first/last *human* prompt — `isHumanText` excludes hook-injected
      // payloads (text starting with `<`) and tool-result-only turns.
      if (isHumanText(userText)) {
        if (!initialPrompt) initialPrompt = textPreview;
        lastPrompt = textPreview;
      }
    }

    return {
      turnIndex,
      ts,
      role: turn.role,
      model: turn.role === "assistant" ? turn.model || null : null,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheCreateTokens: turn.cacheCreateTokens,
      cacheReadTokens: turn.cacheReadTokens,
      isError,
      parentToolUseId: turn.parentToolUseId ?? null,
      textPreview,
      // Adapter path (Codex/Gemini): full text is NOT available. Each
      // adapter caps `assistantText` / `userMessageText` at 500 chars
      // (`adapters/utils.ts` TEXT_CAP) before ingest sees the turn, so the
      // longest text reachable here is already the preview. Indexing
      // `textPreview` keeps these sessions searchable exactly as well as
      // they were before this change — no regression — while native Claude
      // sessions gain full-body coverage. Lifting this needs a widened
      // SessionAdapter contract, which is out of scope here.
      searchText: textPreview,
      toolResultPreview,
      toolUses,
      usageTurn: { ...turn, source: file.source },
      costUsd: turnCostUsd,
      category,
      contextFill: null,
      turnDurationMs: turn.turnDurationMs ?? null,
      hasThinking: 0,
      textOffset: null,
      isSidechain: turn.isSidechain ? 1 : 0,
    };
  });

  const allUsageTurns = parsedTurns.map((t) => t.usageTurn);
  // One walk feeds the session-level counts AND the per-turn stamp, exactly as
  // the Claude path does.
  const adapterTasks = detectOneShotTasks(allUsageTurns);
  const oneShot = summarizeOneShotTasks(adapterTasks);
  // A2: stamp each task's outcome onto its anchor turn. Without this an
  // adapter session persists `task_outcome` NULL on every row, so the SQL
  // backend reports `verifiedTasks: 0` for it while the file backend buckets
  // the very same Edit -> test cycles live — a silent per-backend disagreement
  // on exactly the metric A2 adds (Codex review, PR #378).
  for (const task of adapterTasks) {
    const anchor = parsedTurns[task.anchorIndex];
    // Never stamp a subagent turn: byEffort's task columns are primary-only on
    // both backends. No adapter emits sidechain turns today, so this guards a
    // future one rather than filtering anything live.
    if (anchor && anchor.isSidechain === 0) {
      anchor.taskOutcome = task.oneShot ? "one_shot" : "retry";
    }
  }
  const workMode = aggregateWorkMode(parsedTurns.map((t) => ({ category: t.category })));
  // Same `cache_read / total` fallback the Claude path uses when the quality
  // detector doesn't supply a ratio.
  const cacheHitRatio =
    cacheCreateTokens + cacheReadTokens > 0
      ? cacheReadTokens / (cacheCreateTokens + cacheReadTokens)
      : null;

  // Derive the (day, project, model) and (day, project, category) tuples whose
  // daily_costs / category_costs rollups this session touches — mirrors the
  // Claude path so the caller can batch the refresh.
  const affectedDays = new Set<string>();
  const affectedCategoryTuples = new Set<string>();
  for (const t of parsedTurns) {
    if (t.role !== "assistant") continue;
    const day = t.ts.slice(0, 10);
    if (t.model) affectedDays.add(`${day}|${projectSlug}|${t.model}`);
    if (t.category) affectedCategoryTuples.add(`${day}|${projectSlug}|${t.category}`);
  }

  return {
    sessionId,
    projectDirName,
    projectSlug,
    filePath: file.filePath,
    fileMtimeMs,
    fileSize,
    // Non-Claude sessions are always full-replaced (no tail-append), so the
    // safe cursor is simply the end of the file.
    byteOffset: fileSize,
    // #395: a Claude-transcript concept. No other adapter marks turns as
    // sidechain, so this stays empty rather than being guessed at — and an
    // empty map means "this session records no subagent tool calls", which for
    // a non-Claude session is true rather than merely unmeasured.
    sidechainToolUses: new Map<string, string>(),
    startTs,
    endTs,
    primaryModel: mostFrequent(modelCounts),
    gitBranch: null,
    initialPrompt,
    lastPrompt,
    turnCount: parsedTurns.length,
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
    maxContextFill: null,
    hasCompactionLoop: 0,
    hasToolFailureStreak: 0,
    hasOneShot: oneShot.oneShotTasks > 0 ? 1 : 0,
    verifiedTaskCount: oneShot.totalVerifiedTasks,
    oneShotTaskCount: oneShot.oneShotTasks,
    storedStatus: "inactive",
    slug: null,
    hasThinking: 0,
    cliVersion: null,
    compactBoundaryCount: 0,
    hasResumeAnomaly: 0,
    workModeExplorationPct: workMode.exploration,
    workModeBuildingPct: workMode.building,
    workModeTestingPct: workMode.testing,
    workModeOtherPct: workMode.other,
    source: file.source,
    // Non-Claude harness homes don't participate in the Claude-home
    // discriminator — their sessions are separable via `source` instead.
    homeKey: null,
    // A1 fields are Claude-transcript-specific: the adapter path reaches ingest
    // as `UsageTurn[]`, with no JSONL entry stream to decode these from. Null /
    // empty here means "this harness does not report it", which lands in the
    // same unknown bucket as "this transcript predates it" — both are honest,
    // and neither invents a value.
    sessionKind: null,
    aiTitle: null,
    entrypoint: null,
    permissionModes: [],
    hookRuns: [],
    hookErrors: [],
    prs: [],
    tickets: [],
    turns: parsedTurns,
    affectedDays,
    affectedCategoryTuples,
  };
}

/**
 * Reconcile a single non-Claude session file into the DB via the lean adapter
 * path. Mirrors {@link reconcileSessionFile}'s stat + skip-gate, but parses
 * through the harness adapter's `parseFile` (→ `UsageTurn[]`) and the
 * {@link buildAdapterParsedSession} converter instead of the raw-JSONL reader.
 *
 * The skip-gate is keyed on `file_path` (supplied via `existingMeta` from one
 * up-front SELECT in {@link reconcileAllSessions}) because the real `sessionId`
 * isn't known until the file is parsed — unlike Claude, where it's the
 * filename. No tail-append: non-Claude formats (codex event streams, gemini
 * single-JSON) don't share Claude's append-only line-delimited shape, so a
 * changed file is always fully re-parsed and replaced via `writeSession`'s
 * delete-then-insert.
 */
async function reconcileAdapterSessionFile(
  db: DatabaseT.Database,
  file: SessionFile,
  parseAdapterFile: (f: SessionFile) => Promise<UsageTurn[]>,
  existingMeta:
    | { file_mtime_ms: number; file_size: number; derived_version: number }
    | undefined,
  force: boolean
): Promise<FileReconcileResult> {
  const empty: FileReconcileResult = {
    rowsWritten: 0,
    affectedDays: new Set(),
    affectedCategoryTuples: new Set(),
  };
  let mtimeMs: number;
  let size: number;
  try {
    const s = await fs.stat(file.filePath);
    mtimeMs = Math.floor(s.mtimeMs);
    size = s.size;
  } catch {
    return empty;
  }
  if (size > MAX_SESSION_FILE_SIZE) return empty;

  // Same newer-derivation guard as the Claude path. Adapter files have no
  // tail-append path — a changed file is always fully re-parsed and replaced
  // — so an old build reaching here would rewrite the whole session at its
  // own lower version, losing exactly as much as the Claude path did.
  if (!force && existingMeta && isNewerDerivation(existingMeta.derived_version)) {
    return { ...empty, skippedNewerDerivation: true };
  }

  if (
    !force &&
    existingMeta &&
    existingMeta.file_mtime_ms === mtimeMs &&
    existingMeta.file_size === size &&
    existingMeta.derived_version === DERIVED_VERSION
  ) {
    return empty;
  }

  let turns: UsageTurn[];
  try {
    turns = await parseAdapterFile(file);
  } catch {
    return empty;
  }
  const parsed = buildAdapterParsedSession(file, turns, mtimeMs, size);
  if (!parsed) return empty;

  // `sessions.file_path` is UNIQUE. Look up any row already holding this path:
  // if its session_id DIFFERS from the freshly parsed one (an adapter parser
  // change can alter the resolved id), `writeSession`'s session_id-keyed DELETE
  // would leave it in place and the subsequent INSERT would collide on the
  // UNIQUE(file_path) constraint. Capture the old id so we can both refresh the
  // rollup tuples it contributed to and clear it before the write.
  const existingRow = db
    .prepare("SELECT session_id FROM sessions WHERE file_path = ?")
    .get(file.filePath) as { session_id: string } | undefined;
  const oldSessionId = existingRow?.session_id;

  // Union the (day|project|model) and (day|project|category) tuples the OLD
  // session contributed to, so a model/category/day move — or a
  // DERIVED_VERSION reclassification on re-parse — doesn't strand a stale
  // daily_costs / category_costs row. Mirrors the Claude full-replace path
  // (`reconcileSessionFile`), which unions old + new tuples for the refresh.
  const affectedDays = new Set<string>(parsed.affectedDays);
  const affectedCategoryTuples = new Set<string>(parsed.affectedCategoryTuples);
  if (oldSessionId) {
    for (const t of collectExistingDailyTuples(db, oldSessionId)) affectedDays.add(t);
    for (const t of collectExistingCategoryTuples(db, oldSessionId)) affectedCategoryTuples.add(t);
  }

  let rows = 0;
  const txn = db.transaction(() => {
    // Clear a stale row sharing this UNIQUE file_path under a different id
    // (prompts_fts first, matching writeSession's delete contract) so the
    // INSERT below can't hit the UNIQUE(file_path) constraint.
    if (oldSessionId && oldSessionId !== parsed.sessionId) {
      db.prepare("DELETE FROM prompts_fts WHERE session_id = ?").run(oldSessionId);
      db.prepare("DELETE FROM sessions WHERE session_id = ?").run(oldSessionId);
    }
    rows = writeSession(db, parsed);
  });
  txn();

  return { rowsWritten: rows, affectedDays, affectedCategoryTuples };
}

/**
 * Does a failed `readdir` mean we were unable to read something that is there?
 *
 * `ENOENT` does not: the directory simply does not exist, which is a fact about
 * the corpus rather than a failure to read it. `~/.claude/projects` is absent on
 * a WSL-only setup with a configured extra home, and on any machine that has
 * Claude Code installed but no sessions yet. Counting that as an incomplete
 * enumeration marked EVERY pass aborted, so no completed run was ever recorded,
 * every 30 s sweep repeated the outcome, and the timecard stayed permanently
 * unavailable while the readable home had in fact been scanned in full.
 * (Codex P1, PR #471 — a regression from the previous commit's fix.)
 *
 * Everything else does: EACCES, EIO, EBUSY, a transient UNC error, ENOTDIR from
 * a path that exists but is not a directory. Those mean a corpus that may well
 * be there was not read.
 */
function isMissingDirError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Human-readable `indexer_runs.error` for a pass that completed (or half did). */
function describeRunError(stats: IngestStats): string | null {
  const parts: string[] = [];
  if (stats.enumerationFailures > 0) {
    parts.push(`${stats.enumerationFailures} director(ies) could not be listed`);
  }
  if (stats.errors > 0) parts.push(`${stats.errors} file(s) failed to parse`);
  return parts.length > 0 ? parts.join("; ") : null;
}

export async function reconcileAllSessions(
  db: DatabaseT.Database,
  options: ReconcileOptions = {}
): Promise<IngestStats> {
  // #470: the pass records itself only when asked. See `ReconcileOptions.recordRun`
  // for why the 30 s sweep must not.
  const runId = options.recordRun ? beginIndexerRun(db, options.recordRun) : null;
  // #478: the mixed-derivation memo is a 30-second window on a question this
  // pass is about to change the answer to. A request that cached "the rows
  // agree" moments before a re-derivation starts would keep every later request
  // on the SQL path for the rest of that window — and startup ordering makes
  // that the NORMAL case, not a race: the initial reconcile is deferred, so a
  // first request routinely lands ahead of it (Codex P1, PR #525).
  //
  // Cleared at both edges. The start makes the next read see the mixture; the
  // end makes it see uniformity again rather than diverting for another 30 s
  // after the rebuild has finished.
  clearStaleDerivationMemo();
  clearDerivationChanged();
  let stats: IngestStats | undefined;
  try {
    stats = await runReconcileAllSessions(db, options);
    return stats;
  } finally {
    clearStaleDerivationMemo();
    clearDerivationChanged();
    // `finally`, not the happy path: a pass that threw still has to stop
    // reading as in-progress, or a killed reconcile latches the row open and
    // `closeOrphanedIndexerRuns` becomes the only thing that can clear it.
    finishIndexerRun(db, runId, {
      filesSeen: stats?.filesSeen,
      filesChanged: stats?.filesChanged,
      rowsWritten: stats?.rowsWritten,
      // Per-file parse errors are recorded but still count as a completed pass
      // — the index was populated. Only a throw means the pass did not finish.
      // Both counts, not the first one that happens to be non-zero: a pass can
      // fail an enumeration AND hit unparseable files, and reporting only the
      // former discards the diagnostic the `error` column exists to carry.
      error: stats ? describeRunError(stats) : "reconcile threw",
      // Not read through: the pass threw, OR it completed but could not
      // enumerate some directory it was supposed to. Per-file PARSE errors are
      // a different thing — the file was seen and the pass finished — so those
      // stay `aborted: false` and count as ready. (#471, Codex P1.)
      aborted: stats === undefined || stats.enumerationFailures > 0,
    });
  }
}

async function runReconcileAllSessions(
  db: DatabaseT.Database,
  options: ReconcileOptions = {}
): Promise<IngestStats> {
  const stats: IngestStats = {
    filesSeen: 0,
    filesChanged: 0,
    rowsWritten: 0,
    errors: 0,
    newerDerivationSkips: 0,
    enumerationFailures: 0,
  };

  await loadPricing();

  // ── Multi-harness setup ─────────────────────────────────────────────────
  // Resolve config + discover non-Claude session files BEFORE the Claude walk
  // so a missing `~/.claude/projects` (a Codex/Gemini-only user who never ran
  // Claude) doesn't abort the whole reconcile. With the default config
  // (`enabledAdapters` unset → ["claude"]) `discoverAllSessions` yields Claude
  // files only and the `!== "claude"` filter empties the list — a pure no-op.
  const config = options.config ?? (await readConfig());

  // Claude projects dirs: an explicit options.projectsDir (tests, worker
  // wiring) pins a single dir; otherwise walk every READABLE Claude home
  // (primary + config.claudeHomes). Homes excluded by the never-wake gate
  // (stopped WSL distro) are remembered so the prune pass can shield their
  // already-ingested rows — skipping a home must never delete its sessions.
  let projectsDirs: string[];
  let unavailableDirs: string[] = [];
  if (options.projectsDir) {
    projectsDirs = [options.projectsDir];
  } else {
    const allHomes = getClaudeHomes(config);
    const readableHomes = await getReadableClaudeHomes(config);
    const readableSet = new Set(readableHomes);
    projectsDirs = readableHomes.map((h) => path.join(h, "projects"));
    // Record each home's filesystem case-sensitivity while we are here and the
    // volume is demonstrably reachable (#416). It is the fact `queryByProject`
    // needs and cannot obtain: the DB stores an encoded path string, not the
    // behaviour of the volume that produced it, and that volume may be on
    // another machine or since deleted. Once per RECONCILE and per home — the
    // answer is a property of the volume, not of a project directory.
    //
    // Awaited rather than fired off: a probe that is still running when the
    // reconcile finishes would write into a DB the caller may have closed.
    await recordHomeCaseSensitivity(db, readableHomes);
    unavailableDirs = allHomes
      .filter((h) => !readableSet.has(h))
      .map((h) => path.join(h, "projects"));
  }

  // One up-front read of every existing non-Claude row: powers the per-file
  // skip-gate (keyed on file_path, since the real sessionId isn't known until
  // parse) AND lets us shield those rows from the prune pass if discovery
  // throws — a discovery failure must never mass-delete already-indexed data.
  const existingAdapterMeta = new Map<
    string,
    { file_mtime_ms: number; file_size: number; derived_version: number }
  >();
  for (const r of db
    .prepare(
      "SELECT file_path, file_mtime_ms, file_size, derived_version FROM sessions WHERE source <> 'claude'"
    )
    .all() as Array<{
    file_path: string;
    file_mtime_ms: number;
    file_size: number;
    derived_version: number;
  }>) {
    existingAdapterMeta.set(r.file_path, {
      file_mtime_ms: r.file_mtime_ms,
      file_size: r.file_size,
      derived_version: r.derived_version,
    });
  }

  let adapterSessions: SessionFile[];
  let adapterDiscoveryFailed = false;
  try {
    adapterSessions =
      options.adapterSessions ??
      (await discoverAllSessions(config)).filter((f) => f.source !== "claude");
  } catch (err) {
    adapterSessions = [];
    adapterDiscoveryFailed = true;
    // Same class as a failed `readdir`, and load-bearing for readiness for the
    // same reason: discovery covers an entire harness, so a pass that lost it
    // never saw that corpus at all — yet it returns ordinary stats and would
    // otherwise record itself `aborted = 0` and latch the index ready. The
    // individual adapters already swallow their own missing/unreadable dirs
    // (see `claude.ts` `discover()`), so reaching here means something
    // genuinely unexpected failed, not that a directory is absent.
    stats.enumerationFailures++;
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest] adapter discovery failed: ${(err as Error).message}; preserving existing non-Claude sessions.`
    );
  }
  const parseAdapterFile =
    options.parseAdapterFile ??
    (async (f: SessionFile): Promise<UsageTurn[]> => {
      const adapter = getAdapter(f.source);
      return adapter ? adapter.parseFile(f) : [];
    });

  const subdirs: { projectsDir: string; dirName: string }[] = [];
  let anyDirListed = false;
  for (const dir of projectsDirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      anyDirListed = true;
      for (const e of entries) {
        if (e.isDirectory()) subdirs.push({ projectsDir: dir, dirName: e.name });
      }
    } catch (err) {
      // #471: an enumeration this pass was SUPPOSED to complete and could not.
      // Not the same as a home the never-wake gate deliberately skipped, and
      // not the same as a root that simply is not there — see
      // `isMissingDirError`.
      if (!isMissingDirError(err)) stats.enumerationFailures++;
      // A projects dir that can't be listed — missing primary tree (a
      // WSL-only Claude setup, or a non-Claude user), a distro that stopped
      // mid-cycle, a transient UNC error — shields its rows from the prune
      // pass BY PREFIX. Per-dir shielding (not a blanket keep-all-Claude-rows)
      // so a home that listed successfully but is legitimately empty still
      // prunes its stale rows this cycle.
      unavailableDirs.push(dir);
    }
  }

  // Nothing to discover AND nothing already indexed under a non-Claude source
  // — preserve the original early return so a transient Claude readdir failure
  // doesn't fall through to the prune pass and delete the whole Claude corpus.
  // We must NOT early-return when non-Claude rows already exist (even with no
  // Claude tree), or a Codex/Gemini-only user who disables an adapter could
  // never prune its now-undiscovered sessions. The Claude prune-protection
  // below still shields Claude rows on a Claude-walk failure.
  // BUT: bail only when NO projects dir listed successfully — a missing
  // primary tree with a successfully-listed extra home (a WSL-only Claude
  // setup) must still ingest the extras, and a listed-but-empty extra home
  // must still reach the prune pass so its stale rows are removed.
  if (!anyDirListed && adapterSessions.length === 0 && existingAdapterMeta.size === 0) {
    return stats;
  }

  const liveFilePaths = new Set<string>();
  // Collected across all changed sessions and the prune pass; one
  // refresh at the end avoids recomputing the same (day, project, model)
  // / (day, project, category) tuple N times when N sessions touch the
  // same key.
  const affectedDays = new Set<string>();
  const affectedCategoryTuples = new Set<string>();

  // Sequential per-file because all writes go through the single writer
  // connection. Parallelism would just queue on the busy_timeout. The
  // worker_thread wrap (P2a-2.4) is where we'd consider a producer/consumer
  // split if ingest throughput becomes a bottleneck.
  for (const { projectsDir, dirName } of subdirs) {
    const dirPath = path.join(projectsDir, dirName);
    let filePaths: string[];
    let sessionDirs: string[];
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      filePaths = entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(dirPath, e.name));
      sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      // A project dir that vanished between the home listing and this read is
      // the corpus changing under us, not a read we failed — the next sweep
      // sees the true state. Only a real read failure counts.
      if (!isMissingDirError(err)) stats.enumerationFailures++;
      // A dir that LISTED in the home enumeration but fails its own readdir
      // (distro stopped mid-cycle, transient UNC/EIO error) must not read as
      // "all its sessions vanished" — shield its rows from the prune pass
      // exactly like a home that was skipped up front.
      unavailableDirs.push(dirPath);
      continue;
    }
    // Newer Claude Code writes subagent transcripts to
    // `<project>/<session-id>/subagents/agent-*.jsonl` instead of inlining
    // sidechain entries in the parent session file. Walk one level down so
    // (a) they're reconciled at boot/sweep like any other JSONL and (b)
    // they land in `liveFilePaths` — otherwise the prune pass below would
    // treat their session rows as vanished and delete them every sweep.
    // They ingest under the PROJECT dir name, not "subagents".
    for (const sessionDir of sessionDirs) {
      const subagentsDir = path.join(dirPath, sessionDir, "subagents");
      try {
        const subEntries = await fs.readdir(subagentsDir);
        for (const f of subEntries) {
          if (f.endsWith(".jsonl")) filePaths.push(path.join(subagentsDir, f));
        }
      } catch (err) {
        // No `subagents/` dir is the common case and reads as ENOENT — nothing
        // to read, not a read that failed. Anything else (EACCES on a mount,
        // EIO, a plain file sitting where the dir should be) means transcripts
        // that ARE there went unseen, and a pass that never saw them must not
        // record itself as having read the corpus through. Same predicate as
        // the two enumeration loops above (#471).
        if (!isMissingDirError(err)) stats.enumerationFailures++;
      }
    }
    for (const filePath of filePaths) {
      liveFilePaths.add(filePath);
      stats.filesSeen++;
      try {
        const result = await reconcileSessionFile(db, filePath, dirName, options);
        if (result.skippedNewerDerivation) stats.newerDerivationSkips++;
        if (result.rowsWritten > 0) {
          stats.filesChanged++;
          stats.rowsWritten += result.rowsWritten;
          for (const tuple of result.affectedDays) affectedDays.add(tuple);
          for (const tuple of result.affectedCategoryTuples) affectedCategoryTuples.add(tuple);
        }
      } catch {
        stats.errors++;
      }
    }
  }

  // ── Non-Claude adapter pass (multi-harness) ────────────────────────────
  // Claude sessions are handled by the rich raw-JSONL walk above. Every OTHER
  // enabled harness was discovered up top (`adapterSessions`); ingest each via
  // the lean path: adapter.parseFile -> UsageTurn[] -> buildAdapterParsedSession
  // -> writeSession. Each live file is registered so the prune pass below
  // doesn't treat it as vanished.
  for (const file of adapterSessions) {
    liveFilePaths.add(file.filePath);
    stats.filesSeen++;
    try {
      const result = await reconcileAdapterSessionFile(
        db,
        file,
        parseAdapterFile,
        existingAdapterMeta.get(file.filePath),
        options.force ?? false
      );
      if (result.skippedNewerDerivation) stats.newerDerivationSkips++;
      if (result.rowsWritten > 0) {
        stats.filesChanged++;
        stats.rowsWritten += result.rowsWritten;
        for (const tuple of result.affectedDays) affectedDays.add(tuple);
        for (const tuple of result.affectedCategoryTuples) affectedCategoryTuples.add(tuple);
      }
    } catch {
      stats.errors++;
    }
  }

  // Prune protection: if we couldn't enumerate a source this pass, keep its
  // existing rows "live" so the prune below doesn't delete data we simply
  // failed to re-list. Claude rows are protected per failed dir via the
  // unavailableDirs prefix shield below; non-Claude rows on an adapter
  // discovery failure.
  if (adapterDiscoveryFailed) {
    for (const fp of existingAdapterMeta.keys()) liveFilePaths.add(fp);
  }
  // Rows under a Claude home we deliberately didn't read this cycle (stopped
  // WSL distro, or a mid-cycle listing failure) stay live: the files almost
  // certainly still exist — we just can't look without waking the VM.
  if (unavailableDirs.length > 0) {
    // normalizePathKey yields forward-slash keys on every platform, so the
    // boundary separator MUST be "/" — appending path.sep ("\\" on Windows)
    // would make startsWith never match and the prune below would delete the
    // very rows this shield exists to keep.
    const prefixes = unavailableDirs.map((d) => normalizePathKey(d) + "/");
    for (const r of db
      .prepare("SELECT file_path FROM sessions WHERE source = 'claude'")
      .all() as Array<{ file_path: string }>) {
      const key = normalizePathKey(r.file_path);
      if (prefixes.some((p) => key.startsWith(p))) liveFilePaths.add(r.file_path);
    }
  }

  // Prune sessions whose JSONL file vanished. One SELECT pulls the full
  // (session_id, project_slug, file_path) tuple — no per-row lookup. Cascade
  // FK deletes clean turns / tool_uses / file_edits. The `turns_ad` trigger
  // was dropped in v4, so each session's `prompts_fts` rows are explicitly
  // bulk-deleted here in one scan before the cascade — same contract as
  // `writeSession`'s pre-delete.
  const allSessions = db
    .prepare("SELECT session_id, project_slug, file_path, derived_version FROM sessions")
    .all() as Array<{
      session_id: string;
      project_slug: string;
      file_path: string;
      derived_version: number;
    }>;
  const deleteFtsBySession = db.prepare("DELETE FROM prompts_fts WHERE session_id = ?");
  const deleteStale = db.prepare("DELETE FROM sessions WHERE session_id = ?");
  const deletePrunedDailyByProject = db.prepare(
    "DELETE FROM daily_costs WHERE project_slug = ?"
  );
  const deletePrunedCategoryByProject = db.prepare(
    "DELETE FROM category_costs WHERE project_slug = ?"
  );
  const stalePruned = new Set<string>();
  for (const r of allSessions) {
    if (liveFilePaths.has(r.file_path)) continue;

    // Same rule as the reconcile gates, applied to the other way a build can
    // destroy newer data. The guard there stops an old build REWRITING newer
    // rows; without this one it simply DELETES them instead, which is worse.
    //
    // The reachable path is an adapter this build doesn't have (Codex review,
    // PR #381). `getEnabledAdapters` skips an unknown configured id with only
    // a console.warn, so discovery *succeeds* having found none of that
    // adapter's files — which means `adapterDiscoveryFailed` stays false and
    // the shield above never engages. Its already-indexed sessions are then
    // absent from `liveFilePaths` and look exactly like vanished files. Roll
    // back across a build that added an adapter and the entire newer index for
    // it is deleted, cascading to its turns.
    //
    // Deferring costs nothing: if the file really is gone, the newer build
    // prunes it on its next sweep, when it can also tell the difference. A
    // permanent rollback keeps rows it can no longer re-derive, which is the
    // same trade the reconcile guard makes — stale-but-intact over destroyed.
    // `force` still prunes, so an explicit rebuild is not blocked.
    if (!options.force && isNewerDerivation(r.derived_version)) {
      stats.newerDerivationSkips++;
      continue;
    }

    deleteFtsBySession.run(r.session_id);
    deleteStale.run(r.session_id);
    stalePruned.add(r.project_slug);
  }

  // Pruned sessions removed contributions on their days. Drop the affected
  // projects' daily_costs / category_costs entirely then re-derive every
  // tuple still present for those projects. Cheaper than per-tuple delta
  // math and immune to "project lost its last session for a day".
  if (stalePruned.size > 0) {
    const ph = Array.from(stalePruned).map(() => "?").join(",");
    const dayRows = db
      .prepare(
        `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.model AS model
         FROM turns t JOIN sessions s USING (session_id)
         WHERE t.role = 'assistant' AND t.model IS NOT NULL
           AND s.project_slug IN (${ph})`
      )
      .all(...Array.from(stalePruned)) as Array<{ day: string; project_slug: string; model: string }>;
    for (const r of dayRows) affectedDays.add(`${r.day}|${r.project_slug}|${r.model}`);
    const catRows = db
      .prepare(
        `SELECT DISTINCT substr(t.ts, 1, 10) AS day, s.project_slug AS project_slug, t.category AS category
         FROM turns t JOIN sessions s USING (session_id)
         WHERE t.role = 'assistant' AND t.category IS NOT NULL
           AND s.project_slug IN (${ph})`
      )
      .all(...Array.from(stalePruned)) as Array<{ day: string; project_slug: string; category: string }>;
    for (const r of catRows) affectedCategoryTuples.add(`${r.day}|${r.project_slug}|${r.category}`);
    for (const slug of stalePruned) {
      deletePrunedDailyByProject.run(slug);
      deletePrunedCategoryByProject.run(slug);
    }
  }

  if (affectedDays.size > 0) {
    refreshDailyCosts(db, affectedDays);
  }
  if (affectedCategoryTuples.size > 0) {
    refreshCategoryCosts(db, affectedCategoryTuples);
  }

  // Continuation linking: after sessions have been ingested with their
  // slugs stamped, walk the slug index and point each session's
  // `continued_from_session_id` at the most-recent prior session sharing
  // the same slug. One UPDATE for the whole corpus — per-session linking
  // wouldn't see the full graph (a freshly-written session might be the
  // continuation, OR the predecessor of one not yet read).
  //
  // Skip when no file changed: nothing in the slug graph could have
  // moved, so the UPDATE would be a pure no-op. Watcher reconciles
  // fire frequently and most are no-ops; this gate keeps that path
  // free of incidental work.
  if (stats.filesChanged > 0 || stalePruned.size > 0) {
    refreshContinuationLinks(db);
  }

  // Clear the v3 readiness gate ONLY when the reconcile pass is
  // known-good. Per-file failures land in `stats.errors` without
  // failing the whole pass, so clearing unconditionally would drop the
  // gate while some sessions are still stamped at the old derived_version
  // — at which point the SQL-aggregate path serves silently incomplete
  // totals. Holding the flag until a clean pass means the next watcher
  // tick re-tries the failed files; once they succeed, the gate clears.
  if (stats.errors === 0) {
    db.prepare("DELETE FROM meta WHERE key = 'needs_reconcile_after_v3'").run();
  }

  // Say it out loud. A newer-derivation skip is not an error — the index is
  // intact and richer than this build can produce — but it does mean the
  // running binary is older than whatever last wrote the index, and every
  // surface that reads the newer columns will look empty here. That is a
  // confusing state to debug from the UI alone (it presents as "the feature
  // I just shipped renders nothing"), so name the cause once per pass.
  if (stats.newerDerivationSkips > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingest] ${stats.newerDerivationSkips} session(s) left untouched: their rows were ` +
        `derived by a newer build than this one (this build: DERIVED_VERSION=${DERIVED_VERSION}). ` +
        `The index is intact — this build simply can't re-derive it. Update, or force a rebuild ` +
        `to re-derive at this version.`
    );
  }

  return stats;
}

/**
 * Re-derive `continued_from_session_id` for every session with a known
 * slug. One correlated UPDATE — bounded by the number of slugged
 * sessions, which is small relative to the turns/tool_uses scale this
 * indexer normally moves. Idempotent: re-running produces the same links.
 *
 * Exported for tests; in production it's only called at the tail of
 * `reconcileAllSessions`.
 */
export function refreshContinuationLinks(db: DatabaseT.Database): void {
  db.prepare(
    `UPDATE sessions
        SET continued_from_session_id = (
          SELECT prev.session_id
          FROM sessions prev
          WHERE prev.slug = sessions.slug
            AND prev.session_id <> sessions.session_id
            AND (
              prev.start_ts < sessions.start_ts
              OR (prev.start_ts = sessions.start_ts AND prev.session_id < sessions.session_id)
            )
          ORDER BY prev.start_ts DESC, prev.session_id DESC
          LIMIT 1
        )
      WHERE slug IS NOT NULL`
  ).run();
}
