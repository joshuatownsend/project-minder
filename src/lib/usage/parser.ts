import { promises as fs } from "fs";
import path from "path";
import {
  toSlug,
  type ConversationEntry,
} from "@/lib/scanner/claudeConversations";
import type { UsageTurn } from "./types";
import { FileCache } from "./cache";
import {
  extractText as extractTextRaw,
  extractToolResults as extractToolResultsRaw,
  extractToolResultEntries,
  extractCommandNames,
} from "./contentBlocks";
import {
  buildToolCalls,
  mergeAssistantContinuation,
  openAssistantMessage,
  type OpenAssistantMessage,
} from "./assistantContinuation";
import { extractCacheCreate1hTokens } from "./cacheTtl";
import { resolveSessionJsonl } from "./sessionPath";
import { readConfig } from "@/lib/config";
import { getReadableClaudeHomes } from "@/lib/claudeHome";
import { normalizePathKey } from "@/lib/platform";

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Per-file mtime-keyed cache. Replaces the old 2-min TTL: with mtime caching,
// we only re-parse files that actually changed since last seen. Memory ceiling
// is bounded by FileCache's LRU sweep.
//
// Stored on globalThis so the cache survives Next.js HMR module reloads. Same
// rationale as the existing globalThis caches in /api/sessions, /api/stats etc.
const globalForParser = globalThis as unknown as {
  __usageFileCache?: FileCache<UsageTurn[]>;
  __usageAllSessionsInFlight?: {
    promise: Promise<Map<string, UsageTurn[]>>;
    /** JSON of (claudeHomes, pathMappings) the sweep was started under — a
     *  request under NEW config must not await (and re-cache from) a sweep
     *  that resolved the OLD homes. */
    configKey: string;
  };
};

function getFileCache(): FileCache<UsageTurn[]> {
  if (!globalForParser.__usageFileCache) {
    globalForParser.__usageFileCache = new FileCache<UsageTurn[]>({ maxEntries: 5000 });
  }
  return globalForParser.__usageFileCache;
}

// Content extraction goes through `contentBlocks.ts` so the SQLite ingest
// path produces identical text projections. The slice limits below are
// the legacy file-parse caps (kept for the existing UsageTurn shape).

function extractText(content: any[]): string {
  return extractTextRaw(content).slice(0, 500);
}

function extractToolResults(content: any[]): string {
  return extractToolResultsRaw(content).slice(0, 2000);
}

// ── Dir name canonicalization ─────────────────────────────────────────────────

// In the encoded dir name, ':', '\', and '.' all become '-'.
// Windows paths start with '{Drive}--' (drive colon + first backslash).
// Any '--' after that initial prefix represents '\.' — a dot-prefixed component.
// Worktree dirs are always dot-prefixed (.worktrees, .claude-worktrees, etc.),
// so strip the worktree suffix to group their sessions with the parent project.
// We scan '--' occurrences left-to-right and stop at the FIRST worktree marker.
// Earlier dot-prefixed dirs (e.g. '--cache') don't match the pattern, so the
// loop naturally skips them. Stopping at the first match also ensures a branch
// name that happens to contain '--worktrees-' is never treated as a second marker.
export function canonicalizeDirName(dirName: string): string {
  const searchFrom = /^[A-Za-z]--/.test(dirName) ? 2 : 0;
  let pos = searchFrom;
  while (pos < dirName.length) {
    const idx = dirName.indexOf("--", pos);
    if (idx === -1) break;
    if (/^(?:[a-z]+-)?worktrees-/.test(dirName.slice(idx + 2))) {
      return dirName.slice(0, idx);
    }
    pos = idx + 2;
  }
  return dirName;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Returns the key with the highest count, or null if the map is empty. */
export function mostFrequent<K>(m: Map<K, number>): K | null {
  let best: K | null = null;
  let max = 0;
  for (const [k, v] of m) {
    if (v > max) { max = v; best = k; }
  }
  return best;
}

// Re-exported from sessionPath.ts so the validation regex lives in
// one place. External callers (the /api/sessions/[sessionId]/* routes)
// import from `@/lib/usage/parser` historically; the re-export keeps
// those imports working without touching every callsite.
export { isValidSessionId } from "./sessionPath";

// ── Single-file parser ────────────────────────────────────────────────────────

export interface ParseSessionTurnsOptions {
  /**
   * When true, propagate `fs.readFile` errors instead of swallowing them
   * as `[]`. Used by single-session callers (the diagnosis route) that
   * need to distinguish "found but unreadable" (→ HTTP 500) from "found
   * and parsed empty" (→ HTTP 200 with empty findings). The default
   * (`false`) preserves the legacy sweep behavior in `buildAllSessions`
   * where one bad file shouldn't kill the whole sweep.
   *
   * Per-line `JSON.parse` failures are still soft-skipped regardless of
   * this flag — partial reads of a corrupted JSONL are still useful for
   * diagnosis (the valid lines yield meaningful data).
   */
  strict?: boolean;
  /**
   * When true, include sidechain (subagent) turns instead of skipping them.
   * Turns are tagged with `isSidechain: true` and `parentToolUseId` when
   * available. Used by per-agent cost aggregation; NOT used by the main
   * usage reporting path (default: false preserves existing behavior).
   */
  includeSidechains?: boolean;
  /**
   * normalizePathKey of the Claude home this file was found under. Stamped
   * onto every produced turn (multi-home disambiguation — see
   * UsageTurn.homeKey). Omit for single-session loaders that don't need it.
   */
  homeKey?: string;
}

export async function parseSessionTurns(
  filePath: string,
  projectDirName: string,
  options: ParseSessionTurnsOptions = {}
): Promise<UsageTurn[]> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (options.strict) throw err;
    return [];
  }

  const turns: UsageTurn[] = [];

  // Pre-pass: index tool_result error flags and slash-command markers from
  // user turns. Tool results come AFTER the assistant turn that called the
  // tool, so this pre-pass is required to populate isError/errorCategory on
  // ToolCall objects in the assistant turn during the main loop.
  const errorByToolUseId = new Map<string, { isError: boolean; content: string }>();
  const slashCommandsByTimestamp = new Map<string, Set<string>>();
  for (const line of raw.split("\n")) {
    const trimmedPre = line.trim();
    if (!trimmedPre) continue;
    let preEntry: ConversationEntry;
    try { preEntry = JSON.parse(trimmedPre); } catch { continue; }
    if (preEntry.type !== "user" || preEntry.isSidechain || preEntry.isMeta || !preEntry.timestamp) continue;
    const msgC = preEntry.message?.content ?? [];
    const topC = (preEntry.content ?? []) as unknown[];
    const src = (msgC as unknown[]).length > 0 ? msgC : topC;
    for (const tr of extractToolResultEntries(src)) {
      if (tr.tool_use_id) errorByToolUseId.set(tr.tool_use_id, { isError: tr.isError, content: tr.content });
    }
    const names = extractCommandNames(src);
    if (names.length > 0) slashCommandsByTimestamp.set(preEntry.timestamp, new Set(names));
  }

  let prevUserTimestamp: string | null = null;
  // A3: the most recent user prompt text, threaded onto following assistant
  // turns as `userIntentText` so intent-based categories can attribute their cost.
  let prevUserText: string | undefined;
  // A3 session-scoped metadata, latched during the walk (see the attachment
  // branch below) and stamped onto every turn once the file is fully read.
  let sessionEntrypoint: string | undefined;
  let sessionKindValue: string | undefined;
  // A6: dedup assistant usage by message.id (fallback requestId) within a
  // session. Claude Code can re-log a message (retry / resumed-session re-emit);
  // summing every line would double-count tokens/cost. Only guards ids that are
  // actually present, so genuinely distinct turns (each a unique id) are kept.
  //
  // #453: the guard covers TOKENS only. A repeat id is far more often the same
  // message continuing onto another line than a re-log, so its content blocks
  // are merged into the turn the id already owns rather than discarded — see
  // `assistantContinuation.ts`. Block-level dedupe keeps the re-log case safe.
  const seenMessageIds = new Set<string>();
  const openMessages = new Map<string, OpenAssistantMessage>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ConversationEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // A3: `entrypoint` / `sessionKind` are session-scoped and ride
    // `attachment` entries, which are not turns — so they must be read BEFORE
    // the skip guards below, exactly as the DB ingest path does. Every one of
    // 3,685 corpus sessions carries `entrypoint` on an attachment, so this is
    // the load-bearing carrier, not a fallback. Latched first-non-empty and
    // stamped onto the turns after the loop, because an attachment can appear
    // after the turns it describes.
    if (entry.type === "attachment") {
      if (!sessionEntrypoint && typeof (entry as any).entrypoint === "string" && (entry as any).entrypoint) {
        sessionEntrypoint = (entry as any).entrypoint;
      }
      if (!sessionKindValue && typeof (entry as any).sessionKind === "string" && (entry as any).sessionKind) {
        sessionKindValue = (entry as any).sessionKind;
      }
    }

    // Skip internal entries
    if (entry.isSidechain && !options.includeSidechains) continue;
    if (entry.isMeta) continue;
    if (!entry.timestamp) continue;

    const { type, timestamp } = entry;

    if (type === "assistant") {
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;

      const messageId =
        (entry.message as { id?: string } | undefined)?.id ??
        (entry as { requestId?: string }).requestId;
      // #453: a repeat id CONTINUES the message rather than re-logging it.
      // Merge the line's blocks into the turn that id already owns and skip
      // everything token-bearing below — the first line carried the whole
      // message's `usage`.
      if (messageId && seenMessageIds.has(messageId)) {
        const open = openMessages.get(messageId);
        const turn = open ? turns[open.turnIndex] : undefined;
        if (open && turn) {
          const merged = mergeAssistantContinuation(
            open,
            entry.message?.content,
            errorByToolUseId
          );
          if (merged.toolCalls.length > 0) turn.toolCalls.push(...merged.toolCalls);
          if (merged.text !== null) turn.assistantText = merged.text.slice(0, 500) || undefined;
        }
        continue;
      }
      if (messageId) seenMessageIds.add(messageId);

      const usage = entry.message?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheCreate1hTokens = extractCacheCreate1hTokens(usage);
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      const rawContent = entry.message?.content;
      const content = Array.isArray(rawContent) ? rawContent : [];
      const slashCmds = prevUserTimestamp ? slashCommandsByTimestamp.get(prevUserTimestamp) : undefined;
      // The slash window is latched onto the message here, not re-read per
      // line: a continuation can land after later user turns, and reading the
      // live cursor then would file a split `Skill` call under an unrelated
      // prompt (the ingest-path defect caught in PR #427).
      const open = openAssistantMessage(turns.length, content as any[], slashCmds);
      const toolCalls = buildToolCalls(
        (content as any[]).filter((b: any) => b.type === "tool_use"),
        errorByToolUseId,
        open
      );
      if (messageId) openMessages.set(messageId, open);

      const assistantText = extractText(content) || undefined;

      const isError = entry.isApiErrorMessage === true;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        homeKey: options.homeKey,
        model,
        role: "assistant",
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheCreate1hTokens,
        cacheReadTokens,
        // A1: `effort` and the attribution fields are top-level on the entry,
        // not inside `message`. `speed` is nullable in the transcript — null
        // and absent both mean unknown, so normalise to undefined rather than
        // letting null reach a consumer that would read it as a value.
        effort: entry.effort,
        speed: entry.message?.usage?.speed ?? undefined,
        attributionSkill: entry.attributionSkill,
        attributionMcpServer: entry.attributionMcpServer,
        attributionMcpTool: entry.attributionMcpTool,
        toolCalls,
        assistantText,
        isError,
        userIntentText: prevUserText,
        isSidechain: entry.isSidechain ? true : undefined,
        parentToolUseId: entry.parentToolUseID ?? undefined,
      });
    } else if (type === "user") {
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = entry.content ?? [];

      // Prefer message.content, fall back to top-level content
      const textSource =
        messageContent.length > 0 ? messageContent : topLevelContent;
      const userMessageText = extractText(textSource) || undefined;
      const toolResultText = extractToolResults(textSource) || undefined;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        homeKey: options.homeKey,
        model: "",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText,
        toolResultText,
        // Tag sidechain (subagent) user turns so the primary-only filter in
        // parseAllSessions strips them (A1). Previously only assistant
        // sidechain turns were tagged, so subagent user/tool_result turns
        // leaked into primary-only consumers (one-shot/yield/session flows).
        // parentToolUseId gives file/DB parity for grouping by the spawning
        // Task call.
        isSidechain: entry.isSidechain ? true : undefined,
        parentToolUseId: entry.parentToolUseID ?? undefined,
      });
      prevUserTimestamp = timestamp;
      // A3 intent: prefer the array-extracted text, but fall back to a raw
      // string `message.content` — real human prompts are stored as strings,
      // which the array-only `extractText` above returns "" for. Only a real
      // prompt updates the propagated intent; tool-result-only user turns
      // leave the prior prompt's intent in effect.
      // Sidechain (subagent) user turns don't move the propagated intent —
      // subagent assistant turns are attributed to the primary task's prompt,
      // matching the DB ingest path (which never sees sidechain user turns).
      const intentText = userMessageText ?? (typeof textSource === "string" ? textSource : undefined);
      if (intentText && !entry.isSidechain) prevUserText = intentText;
    }
  }

  // Denormalize the session-constant values onto each turn. The aggregator
  // works over a flat turn list with no session-level side table, so carrying
  // them here is what lets the file backend produce `byEntrypoint` at all.
  if (sessionEntrypoint || sessionKindValue) {
    for (const t of turns) {
      if (sessionEntrypoint) t.entrypoint = sessionEntrypoint;
      if (sessionKindValue) t.sessionKind = sessionKindValue;
    }
  }

  return turns;
}

export interface SessionTurnsMeta {
  compactBoundaries: string[];
  cliVersion: string | null;
  hasThinking: boolean;
}

/**
 * Like `parseSessionTurns` but also extracts session-level metadata that
 * system entries carry: compact_boundary timestamps, CLI version, and whether
 * any assistant turn had thinking blocks. Used by ingest.ts and the diagnosis
 * route; the main sweep cache uses `parseSessionTurns` directly to avoid
 * changing its cached shape.
 */
export async function parseSessionTurnsWithMeta(
  filePath: string,
  projectDirName: string,
  options: ParseSessionTurnsOptions = {}
): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (options.strict) throw err;
    return { turns: [], meta: { compactBoundaries: [], cliVersion: null, hasThinking: false } };
  }

  const turns: UsageTurn[] = [];
  const compactBoundaries: string[] = [];
  const versionCounts = new Map<string, number>();
  let hasThinking = false;
  // Index into turns[] of the last pushed assistant turn (for turn_duration attachment).
  let lastAssistantTurnIdx = -1;

  // Pre-pass: index tool_result error flags and slash-command markers.
  const errorByToolUseIdMeta = new Map<string, { isError: boolean; content: string }>();
  const slashCommandsByTimestampMeta = new Map<string, Set<string>>();
  for (const line of raw.split("\n")) {
    const trimmedPre = line.trim();
    if (!trimmedPre) continue;
    let preEntry: ConversationEntry;
    try { preEntry = JSON.parse(trimmedPre); } catch { continue; }
    if (preEntry.type !== "user" || preEntry.isSidechain || preEntry.isMeta || !preEntry.timestamp) continue;
    const msgC = preEntry.message?.content ?? [];
    const topC = (preEntry.content ?? []) as unknown[];
    const src = (msgC as unknown[]).length > 0 ? msgC : topC;
    for (const tr of extractToolResultEntries(src)) {
      if (tr.tool_use_id) errorByToolUseIdMeta.set(tr.tool_use_id, { isError: tr.isError, content: tr.content });
    }
    const names = extractCommandNames(src);
    if (names.length > 0) slashCommandsByTimestampMeta.set(preEntry.timestamp, new Set(names));
  }
  let prevUserTimestampMeta: string | null = null;
  let prevUserTextMeta: string | undefined;
  // A3 session-scoped metadata, latched during the walk (see the attachment
  // branch below) and stamped onto every turn once the file is fully read.
  let sessionEntrypoint: string | undefined;
  let sessionKindValue: string | undefined;
  // #453: same split as `parseSessionTurns` — the id guard covers tokens, and
  // a repeat id's content blocks merge into the turn that id already owns.
  const seenMessageIdsMeta = new Set<string>();
  const openMessagesMeta = new Map<string, OpenAssistantMessage>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ConversationEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Collect version from every entry.
    if (typeof entry.version === "string" && entry.version) {
      versionCounts.set(entry.version, (versionCounts.get(entry.version) ?? 0) + 1);
    }

    // Handle system entries for meta extraction before the normal skip.
    if (entry.type === "system") {
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

    // A3: `entrypoint` / `sessionKind` are session-scoped and ride
    // `attachment` entries, which are not turns — so they must be read BEFORE
    // the skip guards below, exactly as the DB ingest path does. Every one of
    // 3,685 corpus sessions carries `entrypoint` on an attachment, so this is
    // the load-bearing carrier, not a fallback. Latched first-non-empty and
    // stamped onto the turns after the loop, because an attachment can appear
    // after the turns it describes.
    if (entry.type === "attachment") {
      if (!sessionEntrypoint && typeof (entry as any).entrypoint === "string" && (entry as any).entrypoint) {
        sessionEntrypoint = (entry as any).entrypoint;
      }
      if (!sessionKindValue && typeof (entry as any).sessionKind === "string" && (entry as any).sessionKind) {
        sessionKindValue = (entry as any).sessionKind;
      }
    }

    if (entry.isSidechain && !options.includeSidechains) continue;
    if (entry.isMeta) continue;
    if (!entry.timestamp) continue;

    const { type, timestamp } = entry;

    if (type === "assistant") {
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;

      const messageId =
        (entry.message as { id?: string } | undefined)?.id ??
        (entry as { requestId?: string }).requestId;
      // #453: continuation of a message already turned, not a re-log.
      if (messageId && seenMessageIdsMeta.has(messageId)) {
        const open = openMessagesMeta.get(messageId);
        const turn = open ? turns[open.turnIndex] : undefined;
        if (open && turn) {
          const merged = mergeAssistantContinuation(
            open,
            entry.message?.content,
            errorByToolUseIdMeta
          );
          if (merged.toolCalls.length > 0) turn.toolCalls.push(...merged.toolCalls);
          if (merged.text !== null) turn.assistantText = merged.text.slice(0, 500) || undefined;
          // A message can open with text and think on a later line; without
          // this the session would report no thinking at all.
          if (!hasThinking && Array.isArray(entry.message?.content)) {
            for (const b of entry.message.content as any[]) {
              if (b?.type === "thinking") { hasThinking = true; break; }
            }
          }
        }
        continue;
      }
      if (messageId) seenMessageIdsMeta.add(messageId);

      const usage = entry.message?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheCreate1hTokens = extractCacheCreate1hTokens(usage);
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      const rawContent = entry.message?.content;
      const content = Array.isArray(rawContent) ? rawContent : [];
      const slashCmdsMeta = prevUserTimestampMeta
        ? slashCommandsByTimestampMeta.get(prevUserTimestampMeta)
        : undefined;
      const openMeta = openAssistantMessage(turns.length, content as any[], slashCmdsMeta);
      const toolCalls = buildToolCalls(
        (content as any[]).filter((b: any) => b.type === "tool_use"),
        errorByToolUseIdMeta,
        openMeta
      );
      if (messageId) openMessagesMeta.set(messageId, openMeta);

      const assistantText = extractText(content) || undefined;
      const isError = entry.isApiErrorMessage === true;

      // Check for thinking blocks.
      if (!hasThinking && Array.isArray(content)) {
        for (const b of content as any[]) {
          if (b?.type === "thinking") { hasThinking = true; break; }
        }
      }

      lastAssistantTurnIdx = turns.length;
      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        homeKey: options.homeKey,
        model,
        role: "assistant",
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheCreate1hTokens,
        cacheReadTokens,
        // A1: `effort` and the attribution fields are top-level on the entry,
        // not inside `message`. `speed` is nullable in the transcript — null
        // and absent both mean unknown, so normalise to undefined rather than
        // letting null reach a consumer that would read it as a value.
        effort: entry.effort,
        speed: entry.message?.usage?.speed ?? undefined,
        attributionSkill: entry.attributionSkill,
        attributionMcpServer: entry.attributionMcpServer,
        attributionMcpTool: entry.attributionMcpTool,
        toolCalls,
        assistantText,
        isError,
        userIntentText: prevUserTextMeta,
        isSidechain: entry.isSidechain ? true : undefined,
        parentToolUseId: entry.parentToolUseID ?? undefined,
      });
    } else if (type === "user") {
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = entry.content ?? [];
      const textSource =
        messageContent.length > 0 ? messageContent : topLevelContent;
      const userMessageText = extractText(textSource) || undefined;
      const toolResultText = extractToolResults(textSource) || undefined;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        homeKey: options.homeKey,
        model: "",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText,
        toolResultText,
        // Tag sidechain (subagent) user turns so the primary-only filter in
        // parseAllSessions strips them (A1). Previously only assistant
        // sidechain turns were tagged, so subagent user/tool_result turns
        // leaked into primary-only consumers (one-shot/yield/session flows).
        // parentToolUseId gives file/DB parity for grouping by the spawning
        // Task call.
        isSidechain: entry.isSidechain ? true : undefined,
        parentToolUseId: entry.parentToolUseID ?? undefined,
      });
      prevUserTimestampMeta = timestamp;
      const intentText = userMessageText ?? (typeof textSource === "string" ? textSource : undefined);
      if (intentText && !entry.isSidechain) prevUserTextMeta = intentText;
    }
  }

  const cliVersion = mostFrequent(versionCounts);

  // Denormalize the session-constant values onto each turn. The aggregator
  // works over a flat turn list with no session-level side table, so carrying
  // them here is what lets the file backend produce `byEntrypoint` at all.
  if (sessionEntrypoint || sessionKindValue) {
    for (const t of turns) {
      if (sessionEntrypoint) t.entrypoint = sessionEntrypoint;
      if (sessionKindValue) t.sessionKind = sessionKindValue;
    }
  }

  return { turns, meta: { compactBoundaries, cliVersion, hasThinking } };
}

// ── All-sessions parser with mtime caching ───────────────────────────────────

async function buildAllSessions(): Promise<Map<string, UsageTurn[]>> {
  const cache = getFileCache();

  // Sweep every readable Claude home (primary + config.claudeHomes) — a home
  // inside a stopped WSL distro is excluded for the cycle rather than woken.
  // Each subdir keeps its own home so file paths resolve into the right tree.
  const config = await readConfig();
  const homes = await getReadableClaudeHomes(config);
  const subdirs: { home: string; dirName: string }[] = [];
  for (const home of homes) {
    try {
      const entries = await fs.readdir(path.join(home, "projects"), { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) subdirs.push({ home, dirName: e.name });
      }
    } catch {
      // No projects dir in this home
    }
  }
  if (subdirs.length === 0) return new Map();

  const result = new Map<string, UsageTurn[]>();
  // Track every JSONL we observed during this sweep so we can evict slots for
  // files that were deleted since the last call. Without this, `maxMtimeMs()`
  // keeps reflecting a deleted file's mtime forever and ETags stick to a
  // value that no longer matches reality — clients would get 304s after a
  // session deletion even though the response body changed.
  const liveSet = new Set<string>();

  // Process subdirectories in batches of 5 to avoid overwhelming the FS.
  for (let i = 0; i < subdirs.length; i += 5) {
    const batch = subdirs.slice(i, i + 5);
    await Promise.all(
      batch.map(async ({ home, dirName }) => {
        const dirPath = path.join(home, "projects", dirName);
        const filePaths: string[] = [];
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith(".jsonl")) {
              filePaths.push(path.join(dirPath, e.name));
            }
          }

          // Newer Claude Code writes subagent transcripts to
          // `<project>/<session-id>/subagents/agent-*.jsonl` instead of
          // inlining sidechain entries in the parent file. The SQLite
          // reconciler walks one level down for exactly this; this reader did
          // not, so on the file backend every one of those sessions — and its
          // turns, tokens and cost — was simply absent.
          //
          // That is a whole-report divergence, not an A3 one: totals,
          // byModel, byProject, byCategory and byEffort were all short by the
          // same population. It surfaced through `byEntrypoint` only because
          // subagent transcripts inherit their parent's entrypoint and are
          // overwhelmingly `cli`, which made the shortfall legible as a
          // lopsided bucket rather than a slightly small number (Codex review,
          // PR #381).
          //
          // Attributed to the PROJECT dir name, not "subagents", matching the
          // reconciler. Session id is the file's own basename, so a subagent
          // transcript is its own session on both backends.
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            const subagentsDir = path.join(dirPath, e.name, "subagents");
            try {
              for (const f of await fs.readdir(subagentsDir)) {
                if (f.endsWith(".jsonl")) filePaths.push(path.join(subagentsDir, f));
              }
            } catch {
              /* no subagents dir for this session — the common case */
            }
          }
        } catch {
          return;
        }

        for (const filePath of filePaths) {
          liveSet.add(filePath);

          // FileCache stat's the file, returns the cached parse if mtime+size
          // are unchanged, otherwise calls the factory. Skip oversized files
          // before parsing — they're typically session-in-progress logs that
          // we'll re-evaluate on the next sweep when they may have been rolled.
          //
          // The factory has its own try/catch because a file can disappear in
          // the gap between the FileCache's outer stat and our second stat
          // (log rotation, session pruning). Pre-P1 behavior was "one bad
          // file doesn't kill the sweep" — keep it.
          const turns = await cache.getOrCompute(filePath, async (fp) => {
            try {
              const stat = await fs.stat(fp);
              if (stat.size > MAX_SESSION_FILE_SIZE) return [];
              // Parse WITH sidechains so the cached map carries subagent turns
              // (tagged `isSidechain`). `parseAllSessions()` strips them by
              // default for existing consumers; the usage aggregator opts in
              // via `{ includeSidechains: true }` to fold subagent cost into
              // the totals (A1).
              return await parseSessionTurns(fp, dirName, { includeSidechains: true, homeKey: normalizePathKey(home) });
            } catch {
              return [];
            }
          });

          if (turns && turns.length > 0) {
            const sessionId = path.basename(filePath, ".jsonl");
            result.set(sessionId, turns);
          }
        }
      })
    );
  }

  // Evict slots for files that disappeared since the last sweep. This keeps
  // `maxMtimeMs()` honest as a change signal for ETag computation.
  cache.retainOnly(liveSet);
  return result;
}

export async function parseAllSessions(
  options: { includeSidechains?: boolean } = {}
): Promise<Map<string, UsageTurn[]>> {
  // Single-flight: if pulse + dashboard mount fire in parallel on a cold
  // server, only one of them does the 1.1 GB sweep — the rest await the
  // same promise. After the first call settles, subsequent calls hit the
  // FileCache directly and stat 3k files (cheap), no full re-parse.
  // Keyed by the multi-home config: a caller under a just-saved homes/
  // mappings value starts a fresh sweep instead of awaiting one that was
  // resolving the old homes.
  const inFlightCfg = await readConfig();
  const configKey = JSON.stringify([inFlightCfg.claudeHomes ?? [], inFlightCfg.pathMappings ?? []]);
  let slot = globalForParser.__usageAllSessionsInFlight;
  if (!slot || slot.configKey !== configKey) {
    const promise = buildAllSessions().finally(() => {
      if (globalForParser.__usageAllSessionsInFlight?.promise === promise) {
        globalForParser.__usageAllSessionsInFlight = undefined;
      }
    });
    slot = { promise, configKey };
    globalForParser.__usageAllSessionsInFlight = slot;
  }
  const full = await slot.promise;

  // The cached map carries subagent (sidechain) turns. The usage aggregator
  // opts in to see them; every other consumer gets the historical primary-only
  // view so their per-session logic is unchanged (A1).
  if (options.includeSidechains) return full;
  const filtered = new Map<string, UsageTurn[]>();
  for (const [sid, turns] of full) {
    const primary = turns.filter((t) => !t.isSidechain);
    if (primary.length > 0) filtered.set(sid, primary);
  }
  return filtered;
}

/**
 * Max mtime across all currently cached JSONL files. Used as the input to
 * route ETag computation — when no file has changed since the last response,
 * the ETag is identical and the route can return 304.
 *
 * Note: this only reflects files that have been parsed at least once. Until
 * the first `parseAllSessions()` call completes, it returns 0.
 */
export function getJsonlMaxMtime(): number {
  return getFileCache().maxMtimeMs();
}

/**
 * Sentinel error from `loadSessionTurnsBySessionId` signaling that the
 * JSONL was found but failed to read or parse. Distinct from a `null`
 * return (file not found / oversized) so callers can route the two
 * outcomes to different HTTP statuses — 404 vs 500. Without this split
 * the diagnosis route would render a green "looks healthy" panel on a
 * file the parser couldn't actually read, which is the worst-case
 * failure mode for a quality-diagnosis tool.
 */
export class SessionTurnsLoadError extends Error {
  constructor(
    message: string,
    public readonly sessionId: string,
    public readonly filePath: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SessionTurnsLoadError";
  }
}

/**
 * Locate a single session's JSONL by session id and return its parsed
 * `UsageTurn[]`. Returns `null` when the session id doesn't resolve to
 * a file or the file exceeds the size cap. Throws `SessionTurnsLoadError`
 * when the JSONL was found but failed to read or parse — caller MUST
 * surface that distinctly from "not found" (see class doc).
 *
 * Used by surfaces that need a single session's full turn data
 * (e.g. the Diagnosis API route) without paying the cost of a full
 * `parseAllSessions` sweep on cold start.
 *
 * Implementation: walks `~/.claude/projects/<dir>/<sessionId>.jsonl`
 * across project subdirectories, mirroring `scanSessionDetail`'s
 * fallback. Returns the cached parse via `FileCache` on warm hits,
 * but read/parse failures bypass the cache so a transient EBUSY or
 * corrupt mid-stream line doesn't poison subsequent calls.
 */
export async function loadSessionTurnsBySessionId(
  sessionId: string
): Promise<UsageTurn[] | null> {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) return null;

  // resolveSessionJsonl walks every readable Claude home. ENOENT is folded to
  // null inside it (legitimate: no Claude Code / fresh install → route 404s);
  // any other listing failure on the primary home throws and is wrapped as
  // `SessionTurnsLoadError` so the route surfaces a 500 instead of
  // masquerading as "Session not found" (reviewer-flagged shape).
  let found: { filePath: string; projectDirName: string } | null;
  try {
    found = await resolveSessionJsonl(sessionId);
  } catch (err) {
    throw new SessionTurnsLoadError(
      `Failed to list Claude projects dirs: ${err instanceof Error ? err.message : String(err)}`,
      sessionId,
      "~/.claude/projects",
      err
    );
  }
  if (!found) return null;
  const { filePath: candidate, projectDirName: dir } = found;

  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return null; // removed between resolve and stat
  }
  // Oversized files return null (treated as "not found" by the route's
  // 404 path). Per-turn diagnosis on a 50MB+ JSONL would also stress
  // the parser — bailing here is consistent with the buildAllSessions
  // sweep behavior.
  if (stat.size > MAX_SESSION_FILE_SIZE) return null;
  // Parse in strict mode so `fs.readFile` failures (EACCES, EIO,
  // mid-stream EBUSY from a writer) propagate as throws instead of
  // being swallowed as `[]`. Without `strict: true`, a permissions
  // error on a real session file would render a misleading green
  // "looks healthy" panel — reviewer-flagged (Codex P1 + Copilot).
  // Per-line JSON parse errors still soft-skip; a session with a few
  // mangled lines is still diagnosable from its valid lines.
  //
  // We don't use the FileCache's factory pattern here because that
  // pattern swallows throws as `[]`. Diagnosis is single-session and
  // infrequent, so skipping the cache costs a re-parse on tab-revisit
  // but never produces a misleading healthy verdict on a broken file.
  try {
    return await parseSessionTurns(candidate, dir, { strict: true });
  } catch (err) {
    throw new SessionTurnsLoadError(
      `Failed to parse session JSONL: ${err instanceof Error ? err.message : String(err)}`,
      sessionId,
      candidate,
      err
    );
  }
}

/**
 * Locate the JSONL file for a session across all `~/.claude/projects/` subdirs.
 * Returns `{ filePath, projectDirName }` when found, or `null` when not found.
 * Used by session-detail API routes that need to call `parseSessionTurns` with
 * custom options (e.g. `{ includeSidechains: true }`) before the higher-level
 * `loadSessionTurnsBySessionId` helper applies its own defaults.
 */
export async function findSessionFile(
  sessionId: string
): Promise<{ filePath: string; projectDirName: string } | null> {
  // Thin shim — the implementation lives in sessionPath.ts so the
  // claudeConversations scanner can share the same fs-walk fallback
  // without duplicating the directory traversal.
  return resolveSessionJsonl(sessionId);
}

/**
 * Like `loadSessionTurnsBySessionId` but also returns the `SessionTurnsMeta`
 * (compact boundaries, CLI version, thinking flag) needed by the diagnosis
 * route's `extras` parameter. Returns `null` when the session id can't be
 * resolved (same contract as `loadSessionTurnsBySessionId`).
 */
export async function loadSessionWithMetaBySessionId(
  sessionId: string
): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta } | null> {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) return null;

  // Same multi-home resolve + error contract as loadSessionTurnsBySessionId.
  let found: { filePath: string; projectDirName: string } | null;
  try {
    found = await resolveSessionJsonl(sessionId);
  } catch (err) {
    throw new SessionTurnsLoadError(
      `Failed to list Claude projects dirs: ${err instanceof Error ? err.message : String(err)}`,
      sessionId,
      "~/.claude/projects",
      err
    );
  }
  if (!found) return null;
  const { filePath: candidate, projectDirName: dir } = found;

  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return null; // removed between resolve and stat
  }
  if (stat.size > MAX_SESSION_FILE_SIZE) return null;
  try {
    return await parseSessionTurnsWithMeta(candidate, dir, { strict: true });
  } catch (err) {
    throw new SessionTurnsLoadError(
      `Failed to parse session JSONL: ${err instanceof Error ? err.message : String(err)}`,
      sessionId,
      candidate,
      err
    );
  }
}
