import { promises as fs } from "fs";
import path from "path";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import { canonicalizeDirName, projectSlugFromDirName } from "@/lib/sessions/projectIdentity";
// Re-exported from its original home: six modules import it from here, and a
// pure string rule is not worth a rename sweep. The definition moved to a leaf
// so `sessionsListFromDb` and the shared summary projection can reach it
// without pulling in this module's pricing and fs caches. (#496.)
export { canonicalizeDirName };
import type { UsageTurn } from "./types";
import type { MinderConfig } from "@/lib/types";
import type { SessionFile } from "@/lib/adapters/types";
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
import {
  beginSweepFailureCycle,
  endSweepFailureCycle,
  recordSweepFailure,
  recordSweepSuccess,
  directoryExists,
  pathEntryExists,
} from "@/lib/sweepFailures";

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
  /** Tail of the sweep chain — see `sweepGate`. Ordering only; never awaited
   *  for a value. */
  __usageSweepGate?: Promise<unknown>;
};

function getFileCache(): FileCache<UsageTurn[]> {
  if (!globalForParser.__usageFileCache) {
    // Must exceed the session corpus, and by a wide margin. This is an LRU
    // over a workload that sweeps every file in the same order on every call —
    // LRU's worst case. Below the corpus size the hit rate does not degrade
    // gracefully, it collapses to ~0: each sweep evicts precisely the entries
    // the next sweep asks for first.
    //
    // Measured on a 5,286-session corpus (2026-08-22), warm `parseAllSessions`:
    //   maxEntries 5,000 (corpus + 286) -> 47.8s
    //   maxEntries 20,000               ->  2.2s
    // A 22x cliff, with the boundary crossed silently and no symptom other than
    // "the dashboard got slow". The old value was set when the corpus was far
    // smaller and quietly stopped working once it was passed.
    //
    // It does cost memory, and the trade is deliberate. `retainOnly(liveSet)`
    // evicts any path absent from the sweep's live set — deleted, unreadable,
    // or dropped by a config change such as a removed Claude home — so it never
    // trims a file that is still being read. Steady-state residency is
    // therefore min(corpus, maxEntries), which means raising the cap raises it
    // for every corpus above the old one, roughly +6% here (5,000 -> 5,286
    // entries) and up to 5x on a 25,000-session corpus. What is bought is the
    // 22x above. Memory proportional to corpus, against a CPU cost that is not
    // proportional to anything — it is a cliff, and on the wrong side of it
    // every read of the dashboard re-parses the entire history.
    //
    // An entry count was never a memory bound in the first place: a slot holds
    // one session's whole `UsageTurn[]`, so 5,000 large transcripts can exceed
    // 25,000 small ones. `maxBytes` is the bound that means something (#476);
    // `maxEntries` stays as a runaway backstop, since the two bound different
    // failure modes.
    //
    // **Measured, because the numbers turned out to matter more than expected.**
    // On the reference corpus (5,498 transcripts, 2.51 GB of JSONL), parsed
    // `UsageTurn[]` retains ≈2.0x the source bytes in heap — 153 files spanning
    // the size distribution, 57 MB of source against 114 MB of retained heap.
    // With `maxEntries: 25_000` against 5,498 files NOTHING was evicting: the
    // cap was four times larger than the corpus, so the only thing bounding
    // this cache was the size of the user's history. That is what the byte
    // budget fixes.
    //
    // The ≈2.0x ratio does NOT extrapolate to the whole corpus, and #515
    // originally said it did — "≈5.0 GB, past Node's ~4 GB limit". A
    // whole-sweep measurement puts the real figure at ~1.8 GB. The sample was
    // drawn to span the size distribution, which over-weights the big files
    // relative to their share of the corpus, and anything over
    // `MAX_SESSION_FILE_SIZE` is never parsed at all. The bound is worth having
    // because an unbounded cache is unbounded; it was not averting a crash.
    //
    // The default budget is 1 GiB of source (≈2 GiB heap), which leaves room
    // for the rest of the process under the default limit. Raise it with
    // `MINDER_PARSE_CACHE_MB` on a machine with headroom — a bigger budget is
    // strictly better for the sweep, up to the point where the process cannot
    // afford it.
    //
    // **This bounds what is RETAINED BETWEEN sweeps, not the peak DURING one**
    // (Codex P1, PR #514). `buildAllSessions` collects every parsed session
    // into its `result` map and holds it until the sweep and its consumer are
    // both done, so evicting here only drops a SECOND reference to an array
    // that is still reachable. On a corpus larger than the heap limit the peak
    // is unchanged, and no cache budget can change it. That is #515, and it
    // needs the sweep to aggregate or stream rather than materialise
    // everything at once. What this does buy is a process that does not grow
    // without limit across a long-running session, which is the half that is
    // a cache problem.
    //
    // Eviction above the budget is LARGEST-FIRST, not LRU; see `evictByBytes`
    // for why LRU is the pessimal policy for a full-corpus sweep and what the
    // 2.4%-of-files-hold-50%-of-bytes skew buys.
    const budgetMb = Number(process.env.MINDER_PARSE_CACHE_MB);
    globalForParser.__usageFileCache = new FileCache<UsageTurn[]>({
      // A transcript above `MAX_SESSION_FILE_SIZE` is not parsed — the factory
      // returns `[]` — so the slot retains nothing and must not be charged the
      // file's size. Left at the default, one 72 MB in-progress transcript
      // would evict 72 MB of real parsed turns to hold an empty array.
      // (Codex P2, PR #514.)
      weigh: (turns, size) => (turns.length === 0 ? 0 : size),
      maxEntries: 25_000,
      maxBytes:
        Number.isFinite(budgetMb) && budgetMb > 0
          ? budgetMb * 1024 * 1024
          : 1024 * 1024 * 1024,
    });
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
import { isValidSessionId } from "@/lib/sessionId";

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
  const projectSlug = projectSlugFromDirName(projectDirName);

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
  const projectSlug = projectSlugFromDirName(projectDirName);

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

/**
 * Called once per session the sweep parses, in sweep order.
 *
 * A session id is emitted AT MOST ONCE. Repeats are dropped in the core, so
 * both shapes built on it resolve duplicates identically — first copy wins.
 *
 * The first version let each shape decide: the map form kept `Map.set`'s
 * last-wins because that is what it did before the visitor existed, and the
 * streaming form skipped repeats because a fold cannot un-add the first copy.
 * That was two answers to one question, and it was observable — a streaming
 * caller that JOINS an in-flight map sweep sees the map's answer, so the same
 * request could report different tokens depending on whether an unrelated
 * sweep happened to be running (Codex P2, PR #520).
 *
 * First-wins rather than last-wins because it is the only one a fold can
 * implement, and because `mergeAdapterSessions` already resolved collisions
 * that way and said why: keeping the entry that is already there never deletes
 * a real session's turns to make room.
 *
 * Session ids are UUIDs, so a duplicate means one session reachable through two
 * homes — a WSL tree also mapped from Windows — where both copies are of the
 * same transcript.
 */
type SessionVisitor = (sessionId: string, turns: UsageTurn[]) => void | Promise<void>;

/**
 * The one sweep. Walks every readable Claude home plus every enabled adapter
 * and hands each parsed session to `visit` as it is produced.
 *
 * Extracted from `buildAllSessions` for #515: that function accumulated every
 * session's turns into a map and held it until its consumer finished, so a
 * report materialised the WHOLE corpus at once and its peak scaled with the
 * corpus rather than with any bound. `FileCache`'s byte budget (#476) cannot
 * help there — evicting a slot only drops a SECOND reference to an array the
 * caller's map still holds — which is why the map form's measured peak barely
 * moves when `MINDER_PARSE_CACHE_MB` is cut by 8x while the streaming form's
 * halves. (#515 originally claimed ~5.0 GB and an out-of-memory risk; that was
 * an extrapolation, and the measured figure is ~1.8 GB. The unbounded scaling
 * is the real defect, not a crash.)
 *
 * A visitor rather than an async generator, because the sweep's concurrency is
 * `Promise.all` over batches of five and a generator cannot yield from inside
 * those callbacks. Restructuring them would have rewritten the per-file and
 * per-directory error containment (the `continue`-vs-`return` split below),
 * which is load-bearing and was itself review-derived.
 */
async function sweepSessions(visit: SessionVisitor): Promise<void> {
  const cache = getFileCache();
  // #513: the failures below used to be caught and discarded, so the corpus
  // shrank silently and `complete: true` was still reported. Cleared at the
  // START, so a pass that throws part way through still leaves behind what it
  // observed.
  // Sweep every readable Claude home (primary + config.claudeHomes) — a home
  // inside a stopped WSL distro is excluded for the cycle rather than woken.
  // Each subdir keeps its own home so file paths resolve into the right tree.
  //
  // Read BEFORE the cycle opens, deliberately. If either of these rejects — a
  // transient config read, a WSL lookup that times out — the `finally` below
  // would still end a cycle that had enumerated nothing and publish its empty
  // result as this pass's answer, erasing a known failure and reporting
  // `complete: true` on the strength of a pass that never touched the
  // filesystem. A cycle now exists only once there is something to sweep.
  // (Codex P2, PR #527.)
  const config = await readConfig();
  const homes = await getReadableClaudeHomes(config);

  const sweepToken = beginSweepFailureCycle("usage");
  try {
  const subdirs: { home: string; dirName: string }[] = [];
  for (const home of homes) {
    try {
      const entries = await fs.readdir(path.join(home, "projects"), { withFileTypes: true });
      // The success side of the same `readdir` whose failure is reported below,
      // so the two can never disagree about what happened. A later clean pass
      // is what retires an older sweep's complaint about this exact path — see
      // `retireVerified` (#513).
      recordSweepSuccess("usage", path.join(home, "projects"), sweepToken);
      const dirNames: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) dirNames.push(e.name);
      }
      // Sorted, because `readdir` gives no order guarantee and this list is now
      // the PRIORITY for duplicate session ids (#522). Homes keep their
      // configured order, so the primary home wins over a later-configured one.
      dirNames.sort();
      for (const dirName of dirNames) subdirs.push({ home, dirName });
    } catch (err) {
      // Still not fatal — a home that cannot be listed must not take the sweep
      // down — but no longer SILENT (#513).
      // ENOENT here is AMBIGUOUS, and the benign reading is the common one: a
      // fresh install has a `~/.claude` but no `projects/` until the first
      // session is written. Reporting that as degraded would put a permanent
      // warning on every new install (Codex P2 + Copilot, PR #527).
      //
      // So ENOENT counts only when the HOME itself is gone — a moved or
      // unmounted home, which is a real gap. One extra `stat`, on a path that
      // has already failed, so it costs nothing in the normal case.
      //
      // And `projects/` must be absent as an ENTRY, not merely unreadable.
      // Checking the home alone let a `projects` SYMLINK pointing at a
      // disconnected drive read as a fresh install: `readdir` gives ENOENT,
      // the home is right there, and the one case a user most needs told about
      // was reported as healthy. `pathEntryExists` uses `lstat`, which sees the
      // broken link (Codex P2, PR #527).
      const code = (err as NodeJS.ErrnoException)?.code;
      const projectsDir = path.join(home, "projects");
      if (
        code === "ENOENT" &&
        (await directoryExists(home)) &&
        !(await pathEntryExists(projectsDir))
      ) {
        // Home present, no `projects/` yet: nothing has been recorded, and
        // nothing is missing.
      } else {
        recordSweepFailure({
          path: projectsDir,
          scope: "projects-dir",
          code,
          sweep: "usage",
        }, sweepToken);
      }
      // No projects dir in this home
    }
  }
  // Session ids emitted so far, so `visit` can be told whether it is seeing a
  // repeat. Ids only — this is the one thing the sweep still accumulates, and
  // it is ~5.5k strings rather than the corpus.
  const emitted = new Set<string>();

  /**
   * Visitors run ONE AT A TIME, in the order sessions finished parsing.
   *
   * Parsing is `Promise.all` over batches of five, so without this the visitor
   * calls overlap — and the usage visitor awaits per turn while costing, so a
   * short session could finish updating every accumulator map before a long
   * session that started earlier. The map path could not do that: `result.set`
   * is synchronous, so the interleaving ended there and the consumer walked the
   * map in one fixed order. Several report arrays sort by a single descending
   * key and fall back to insertion order for ties — `byModel`, `byProject`,
   * `byCategory`, `topTools` (Codex P2, PR #520).
   *
   * ENQUEUE, DO NOT AWAIT, at the call sites. `emit` fixes a session's place in
   * the queue at the moment its parse completed, which is exactly where
   * `result.set` put it — so the fold sees the map path's order. Awaiting each
   * emission instead (the first attempt) stalled the per-directory file loop
   * behind a slow visit, which delayed later parses and therefore CHANGED that
   * order — the opposite of the intent (Codex P2, round 2).
   *
   * The queue is bounded, because an unbounded one would hold every session's
   * turns whenever the visitor is slower than the parser and hand #515 its own
   * defect back. `QUEUE_LIMIT` sessions may wait; past that the sweep drains
   * before enqueueing more. The bound is still strictly better than the map
   * path, which held all of them unconditionally.
   *
   * Order therefore matches the map path except under sustained visitor
   * backpressure, where memory is bounded instead. Tie ordering is not stable
   * run-to-run in either shape anyway — see #522.
   */
  const QUEUE_LIMIT = 5;
  let queued = 0;
  let visitChain: Promise<void> = Promise.resolve();
  // The FIRST visitor error, rethrown after the queue drains. The chain itself
  // must not reject — a rejected chain would skip every visit behind it — but
  // the failure cannot be swallowed either, or a sweep would report success
  // having folded nothing.
  let visitError: unknown;
  let visitFailed = false;

  const emit = async (sessionId: string, turns: UsageTurn[]): Promise<void> => {
    queued++;
    visitChain = visitChain.then(async () => {
      try {
        await visit(sessionId, turns);
      } catch (e) {
        if (!visitFailed) {
          visitFailed = true;
          visitError = e;
        }
      } finally {
        queued--;
      }
    });
    // Backpressure only at the bound, so the common path never stalls a parse.
    if (queued >= QUEUE_LIMIT) await visitChain;
  };
  // Track every JSONL we observed during this sweep so we can evict slots for
  // files that were deleted since the last call. Without this, `maxMtimeMs()`
  // keeps reflecting a deleted file's mtime forever and ETags stick to a
  // value that no longer matches reality — clients would get 304s after a
  // session deletion even though the response body changed.
  const liveSet = new Set<string>();

  // NOT `if (subdirs.length === 0) return new Map()`, which is what stood here
  // and what this loop's condition now expresses instead. That early return
  // predates adapter discovery and became a hole the moment the merge below was
  // added: an installation running Codex or Gemini with no readable Claude
  // projects tree has zero subdirs, so it returned an empty map before reaching
  // the adapters — and the file backend reported an empty corpus for exactly the
  // users this change exists to serve. (Codex P1, PR #490.)
  //
  // ── Phase 1: ENUMERATE ────────────────────────────────────────────────
  //
  // Every candidate file is listed before ANY of them is parsed, so which copy
  // of a duplicated session id wins is decided by position in a sorted list
  // rather than by which parse happened to finish first (#522).
  //
  // The old shape enumerated and parsed in the same per-directory callback and
  // claimed ids at emission time — so two homes holding the same session UUID
  // resolved to whichever won a race, and two sweeps of an unchanged tree could
  // disagree. Listing first also means the losing copy is never parsed at all.
  //
  // Cost: one array of ~6.6k paths. Not the corpus.
  const perDir: string[][] = new Array(subdirs.length);
  for (let i = 0; i < subdirs.length; i += 5) {
    const batch = subdirs.slice(i, i + 5);
    await Promise.all(
      batch.map(async ({ home, dirName }, k) => {
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
          const sessionDirs: string[] = [];
          for (const e of entries) {
            if (e.isDirectory()) sessionDirs.push(e.name);
          }
          sessionDirs.sort();
          for (const name of sessionDirs) {
            const subagentsDir = path.join(dirPath, name, "subagents");
            try {
              const nested = (await fs.readdir(subagentsDir)).filter((f) => f.endsWith(".jsonl"));
              nested.sort();
              for (const f of nested) filePaths.push(path.join(subagentsDir, f));
            } catch (err) {
              // Absent is the COMMON case and not a failure — most sessions
              // delegate nothing. Unreadable is a different thing: those
              // transcripts, and their tokens and cost, drop out of every
              // aggregate exactly as a missing project directory's would
              // (Codex P2, PR #527).
              const code = (err as NodeJS.ErrnoException)?.code;
              if (code !== "ENOENT") {
                recordSweepFailure(
                  {
                    path: subagentsDir,
                    scope: "project-dir",
                    code,
                    sweep: "usage",
                  },
                  sweepToken
                );
              }
            }
          }
        } catch (err) {
          // One encoded project directory with a restrictive ACL loses that
          // project's whole history from every usage aggregate. Reported at
          // this granularity rather than as "the home is gone", because those
          // are different problems with different fixes (#513).
          recordSweepFailure(
            {
              path: dirPath,
              scope: "project-dir",
              code: (err as NodeJS.ErrnoException)?.code,
              sweep: "usage",
            },
            sweepToken
          );
          perDir[i + k] = [];
          return;
        }
        // Sorted within the directory for the same reason the directories are:
        // this list is the duplicate-resolution priority.
        filePaths.sort();
        perDir[i + k] = filePaths;
      })
    );
  }

  // ── Phase 2: RANK THE CANDIDATES ──────────────────────────────────────
  //
  // Each session id gets its candidate files in PREFERENCE order — first in
  // (home order, directory name, file name). Not a single winner: the first
  // copy is only preferred, not guaranteed usable.
  //
  // Claiming a winner here and discarding the rest was the first version, and
  // it turned a transient problem in the preferred copy into a permanently
  // missing session — unreadable, deleted after enumeration, over the size
  // limit, or parsing to no turns all left the id claimed and the readable
  // second-home copy dropped without ever being opened. The pre-restructure
  // code deduped AFTER parsing and so fell through naturally (Codex P2 +
  // Copilot, PR #524).
  //
  // `liveSet` records every file OBSERVED, alternates included: one may still
  // hold a cache slot from a sweep it won, and dropping it from the live set
  // would evict that slot and take its mtime out of the ETag signal.
  type Candidate = { filePath: string; home: string; dirName: string };
  const candidates = new Map<string, Candidate[]>();
  const idOrder: string[] = [];
  for (let idx = 0; idx < subdirs.length; idx++) {
    const { home, dirName } = subdirs[idx];
    for (const filePath of perDir[idx] ?? []) {
      liveSet.add(filePath);
      const sessionId = path.basename(filePath, ".jsonl");
      const list = candidates.get(sessionId);
      if (list) {
        list.push({ filePath, home, dirName });
      } else {
        candidates.set(sessionId, [{ filePath, home, dirName }]);
        idOrder.push(sessionId);
      }
    }
  }

  // ── Phase 3: PARSE and EMIT ───────────────────────────────────────────
  //
  // Batched over FILES now rather than directories. The unit of concurrency
  // changed with the restructure; five at a time is the same budget.
  //
  // Parsed concurrently, EMITTED IN CLAIM ORDER. Emitting as each parse
  // resolved left order dependent on turn count — a 1-turn session overtook a
  // 20-turn one in the same batch, so an unchanged tree still produced
  // `[s1, s2, s4, s3]` on one run and `[s1, s2, s3, s4]` on another. Collecting
  // a batch and then emitting it in order costs the same residency the visitor
  // queue already allows (five sessions), and buys the order the whole issue is
  // about (#522).
  for (let i = 0; i < idOrder.length; i += 5) {
    const batch = idOrder.slice(i, i + 5);
    const parsed = await Promise.all(
      batch.map(async (sessionId) => {
        // FileCache stat's the file, returns the cached parse if mtime+size
        // are unchanged, otherwise calls the factory. Skip oversized files
        // before parsing — they're typically session-in-progress logs that
        // we'll re-evaluate on the next sweep when they may have been rolled.
        //
        // A file can disappear in the gap between the FileCache's outer stat
        // and our second stat (log rotation, session pruning), so one bad
        // file must not kill the sweep.
        //
        // The catch used to be inside the factory, which converted a read
        // failure into `[]` and CACHED it under the file's mtime+size. This
        // is the biggest corpus in the app, and it carried the same defect
        // #495 found twice on the adapter path: restoring permissions
        // touches ctime, so an EACCES'd transcript stayed missing from every
        // usage aggregate until its contents changed or the process
        // restarted. `parseSessionTurns` swallowed the error on its own
        // account too, hence `strict` — the option existed and nothing used
        // it. (#498.)
        //
        // `getOrCompute` stores nothing when its factory rejects, so the
        // retry is automatic and containment stays per-file.
        //
        // `return`, not `continue`: this is now a per-FILE callback, so
        // returning abandons one file rather than a project's remaining
        // transcripts. The keyword follows the shape, which is the rule
        // Codex and Copilot established on PR #499 when the shapes differed.
        // Each candidate in turn, until one yields turns. Ordinary sessions
        // have exactly one, so this is a single iteration in every case but
        // the duplicate one.
        const forId = candidates.get(sessionId) ?? [];
        for (let ci = 0; ci < forId.length; ci++) {
        const { filePath, home, dirName } = forId[ci];
        let turns: UsageTurn[] | undefined;
        try {
          turns = await cache.getOrCompute(filePath, async (fp) => {
            // Oversized returns `[]` rather than rejecting: the file WAS
            // stat'd and is deliberately not parsed, which is a verdict about
            // it and stays true until the size changes. Cacheable.
            const stat = await fs.stat(fp);
            if (stat.size > MAX_SESSION_FILE_SIZE) return [];
            // Parse WITH sidechains so the cached map carries subagent turns
            // (tagged `isSidechain`). `parseAllSessions()` strips them by
            // default for existing consumers; the usage aggregator opts in
            // via `{ includeSidechains: true }` to fold subagent cost into
            // the totals (A1).
            return await parseSessionTurns(fp, dirName, {
              includeSidechains: true,
              homeKey: normalizePathKey(home),
              strict: true,
            });
          });
        } catch {
          // This copy is unreadable; the next one may not be.
          continue;
        }

        if (turns && turns.length > 0) {
          // The copies we are about to SKIP are still part of the corpus, and
          // the fingerprint has to know about them or a swap between copies can
          // be invisible to it. One `stat` each, and only in the duplicate case.
          for (let rest = ci + 1; rest < forId.length; rest++) {
            await cache.observe(forId[rest].filePath);
          }
          return { sessionId, turns };
        }
        // Parsed to nothing — oversized, or empty. Try the next copy.
        }
        return null;
      })
    );
    for (const entry of parsed) {
      if (!entry) continue;
      // Recorded HERE, at emission. The candidate restructure moved dedupe out
      // of this loop and stopped populating `emitted` along with it — so
      // `mergeAdapterSessions` could no longer see a collision with a Claude
      // session, and an adapter reusing a Claude session id had its turns ADDED
      // to the streaming totals while the map form silently replaced the Claude
      // entry (Codex P2, PR #524).
      //
      // At emission rather than at claim time, so a session whose every copy
      // failed to parse leaves its id free for an adapter that can supply one.
      emitted.add(entry.sessionId);
      await emit(entry.sessionId, entry.turns);
    }
  }

  // ── Non-Claude adapter sessions (#475) ────────────────────────────────
  //
  // Until this landed, `discoverAllSessions` was imported by `db/ingest.ts` and
  // by nothing else: the SQL backend indexed every enabled adapter while every
  // file-parse entry point walked `<claude-home>/projects/**` and stopped. The
  // two backends were therefore not equivalent, and #472 made that matter by
  // widening file-parse's serving window to the whole of the first reconcile —
  // so `data/index.ts` had to add `fileParseCoversCorpus()` to REFUSE to divert
  // whenever adapter sessions existed, leaving exactly those users with the
  // original defect. This closes it for the three usage loaders.
  //
  // Merged after the Claude sweep and into the same map, because the aggregator
  // is already source-aware: it filters on `t.source ?? "claude"` and builds its
  // by-source breakdown from the same turns (`aggregator.ts:69,474`). Confirmed
  // against that code rather than taken on the issue's word.
  await mergeAdapterSessions(config, cache, emit, emitted, liveSet);

  // Evict slots for files that disappeared since the last sweep. This keeps
  // `maxMtimeMs()` honest as a change signal for ETag computation.
  //
  // Adapter files are in `liveSet` too — `mergeAdapterSessions` adds them.
  // Omitting them would evict every adapter slot on each sweep, so they would
  // be re-parsed every time AND `maxMtimeMs()` would ignore adapter edits,
  // leaving ETags claiming "unchanged" across a real change.
  // Drain. The call sites enqueue without awaiting, so this is where the tail
  // of the queue is actually run — and where a visitor's failure surfaces.
  await visitChain;
  if (visitFailed) throw visitError;

  cache.retainOnly(liveSet);
  } finally {
    // In a `finally`: a pass that threw still publishes what it observed, and
    // those partial findings are usually the relevant ones — a failure severe
    // enough to stop the sweep is exactly what a reader needs to see (#513).
    endSweepFailureCycle("usage", sweepToken);
  }
}

/**
 * The map shape of the sweep: every session's turns, resident at once.
 *
 * **Costs the whole corpus in heap** — see `sweepSessions`. Kept because
 * several consumers genuinely index by session id (`runFileAgentUsage`,
 * `runFileSkillUsage`, the per-project analytics routes), and converting all of
 * them in one change would have been a worse diff than converting the one that
 * was measured at 5 GB. New callers that only fold should use
 * `streamAllSessions` instead.
 */
async function buildAllSessions(): Promise<Map<string, UsageTurn[]>> {
  const result = new Map<string, UsageTurn[]>();
  // No duplicate handling here any more — the core emits each id once, so
  // `Map.set` cannot be reached twice for the same key. This path is no longer
  // bit-identical to its pre-visitor self in exactly one case (two homes
  // holding different copies of one session id, where the LATER copy used to
  // win); that divergence is the price of the two shapes agreeing, and the
  // agreement is what makes a report independent of concurrent sweeps.
  await sweepSessions((sessionId, turns) => {
    result.set(sessionId, turns);
  });
  return result;
}

/**
 * Parse every enabled non-Claude adapter's sessions and merge them into the
 * all-sessions map.
 *
 * **Non-Claude only.** The Claude adapter's `discover()` walks the same projects
 * trees the sweep above just finished walking, so including it would double the
 * work and re-parse the whole corpus through a second code path.
 *
 * Failures are contained at three levels, matching the Claude sweep's existing
 * "one bad file doesn't kill the sweep" contract: a discovery that throws drops
 * that adapter, a parse that throws drops that file, and neither can fail the
 * usage report. The alternative — an unreadable `~/.codex` taking down /usage
 * for a Claude corpus that parsed perfectly — is strictly worse than a report
 * that is short by one source.
 */
async function mergeAdapterSessions(
  config: MinderConfig,
  cache: ReturnType<typeof getFileCache>,
  // The SERIALIZED emitter, not the raw visitor — this walks adapter files in
  // `Promise.all` batches too, so it needs the same ordering guarantee.
  emit: (sessionId: string, turns: UsageTurn[]) => Promise<void>,
  emitted: Set<string>,
  liveSet: Set<string>
): Promise<void> {
  // Dynamic import, and it has to be: `@/lib/adapters` registers the Claude
  // adapter, which imports `parseSessionTurns` from THIS module. A static import
  // would close that cycle at module-evaluation time.
  const { getEnabledAdapters } = await import("@/lib/adapters");
  const adapters = getEnabledAdapters(config).filter((a) => a.id !== "claude");
  if (adapters.length === 0) return;

  for (const adapter of adapters) {
    // Typed rather than inferred-to-`any` by a bare `let`: `file.filePath` and
    // `file.projectDirName` below are the adapter contract, and an untyped
    // binding would stop checking them against it. (Copilot, PR #490.)
    let files: SessionFile[];
    try {
      files = await adapter.discover();
    } catch {
      continue;
    }

    for (let i = 0; i < files.length; i += 5) {
      const batch = files.slice(i, i + 5);
      await Promise.all(
        batch.map(async (file) => {
          liveSet.add(file.filePath);
          // **The catch is OUTSIDE `getOrCompute`, and that is the whole
          // point.** It used to sit inside the factory, so a read failure was
          // converted to `[]` and CACHED under the file's mtime+size — and
          // restoring permissions touches ctime, so the session stayed missing
          // from every usage aggregate until its contents changed or the
          // process restarted. The same defect was found twice on the session
          // list (#495); it had been sitting here since #490, unreported,
          // because nothing on this surface makes one absent session visible.
          //
          // `getOrCompute` stores nothing when its factory rejects, so moving
          // the catch out is the entire fix: no verdict recorded, next sweep
          // retries. Containment stays per-file — this runs inside a
          // `Promise.all` over a batch of five, and one unreadable transcript
          // must not take the other four with it. (#498.)
          let turns: UsageTurn[] | undefined;
          try {
            turns = await cache.getOrCompute(file.filePath, async (fp) => {
              // The same `MAX_SESSION_FILE_SIZE` cap the Claude sweep applies
              // above, and that `reconcileAdapterSessionFile` applies on the SQL
              // side (`ingest.ts:3706`). Both adapter parsers read the whole
              // file with `fs.readFile` and this loop runs five at a time, so an
              // uncapped oversized transcript is hundreds of megabytes resident
              // — but the reason it belongs here is narrower than memory: the
              // SQL backend SKIPS these files, so parsing them would make the
              // fallback include sessions the index deliberately excludes. A new
              // divergence, introduced by the change closing one. (Codex P2 +
              // Copilot, PR #490.)
              //
              // Oversized returns `[]` rather than rejecting: the file WAS
              // stat'd and is deliberately not parsed, which is a verdict and
              // stays true until the size changes. Cacheable.
              const stat = await fs.stat(fp);
              if (stat.size > MAX_SESSION_FILE_SIZE) return [];
              return await adapter.parseFile(file);
            });
          } catch {
            return;
          }
          if (!turns || turns.length === 0) return;

          // Keyed by the turn's OWN `sessionId`, not the file's basename. Codex
          // reads its id from the `session_meta` line and falls back to the
          // basename only when that is absent (`codex.ts:257`), so a basename
          // key would disagree with the id those same turns carry — and with
          // the id ingest stores, which is what any "same corpus" claim rests
          // on. A file with no parseable meta yields zero turns and is skipped
          // above.
          const sessionId = turns[0].sessionId;
          if (!sessionId) return;

          // A collision with an already-swept Claude session keeps the Claude
          // entry. Overwriting would silently delete a real session's turns from
          // every usage aggregate to make room for an adapter's — a worse
          // failure than the reverse, and invisible in the totals. Adapter ids
          // are UUIDs in practice, so this is a guard, not a live case.
          if (emitted.has(sessionId)) {
            warnOnceParser(
              `adapter-id-collision:${sessionId}`,
              `[usage] ${adapter.id} session ${sessionId} collides with an ` +
                "already-parsed session id; keeping the existing entry."
            );
            return;
          }
          emitted.add(sessionId);
          await emit(sessionId, turns);
        })
      );
    }
  }
}

const _warnedParser = new Set<string>();
function warnOnceParser(key: string, message: string): void {
  if (_warnedParser.has(key)) return;
  _warnedParser.add(key);
  console.warn(message);
}

/**
 * Serializes sweeps against each other. Not a lock on the FileCache — a lock on
 * `retainOnly`, which is the one part of a sweep that is destructive and whose
 * correctness depends on having seen every live file. Two sweeps running at
 * once each evict the other's files.
 */
function sweepGate(): Promise<unknown> {
  return globalForParser.__usageSweepGate ?? Promise.resolve();
}
function setSweepGate(p: Promise<unknown>): void {
  // Swallow rejection on the GATE only. The caller still awaits its own
  // promise and sees the error; the gate exists to order the next sweep, and a
  // failed sweep must not poison every sweep after it.
  globalForParser.__usageSweepGate = p.catch(() => undefined);
}

/**
 * What makes two sweeps "the same sweep". Shared by the map and streaming entry
 * points so a streamer can join an in-flight map sweep only when it would have
 * produced the same corpus.
 */
function sweepConfigKey(cfg: MinderConfig): string {
  return JSON.stringify([
    cfg.claudeHomes ?? [],
    cfg.pathMappings ?? [],
    cfg.enabledAdapters ?? [],
  ]);
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
  // `enabledAdapters` is part of the key (#475): the sweep now parses adapter
  // sessions, so a caller arriving after an adapter was toggled in Settings must
  // start a fresh sweep rather than await one that resolved the old adapter set.
  // Without it the toggle appears to do nothing until the process restarts.
  const configKey = sweepConfigKey(inFlightCfg);
  let slot = globalForParser.__usageAllSessionsInFlight;
  if (!slot || slot.configKey !== configKey) {
    // Behind the same gate as `streamAllSessions`, for the `retainOnly`
    // reason documented there.
    const promise = sweepGate()
      .then(() => buildAllSessions())
      .finally(() => {
        if (globalForParser.__usageAllSessionsInFlight?.promise === promise) {
          globalForParser.__usageAllSessionsInFlight = undefined;
        }
      });
    setSweepGate(promise);
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
 * Fold every session's turns WITHOUT holding the corpus (#515).
 *
 * `visit` is called once per session, in sweep order, with that session's
 * turns. The array is released as soon as `visit` returns, so a consumer that
 * folds into running totals has a peak proportional to its own accumulators
 * plus one session — not to the corpus. `parseAllSessions` is the same sweep
 * with `result.set` as its visitor, and costs the corpus.
 *
 * Sidechain filtering matches `parseAllSessions`: primary-only by default,
 * `includeSidechains` to see subagent turns. Filtered per session rather than
 * by building a second map, which is what the map form has to do.
 *
 * ## Sharing a sweep with the map form
 *
 * Three cases, and the ordering between them is the whole design:
 *
 * 1. A map sweep for the SAME config is already in flight — await it and
 *    iterate what it produced. Joining costs no additional memory (that map is
 *    being built either way) and avoids parsing the corpus twice.
 * 2. Otherwise this runs its own sweep, serialized behind `sweepGate` along
 *    with every other sweep. Concurrent streamers therefore run one after
 *    another against a warm `FileCache` rather than in parallel.
 * 3. The gate is not an optimisation. `sweepSessions` ends with
 *    `cache.retainOnly(liveSet)`, so two interleaved sweeps would each evict
 *    the files only the other saw — dropping them from `maxMtimeMs()` and
 *    leaving ETags claiming "unchanged" across a real edit.
 *
 * Deliberately not a broadcast/tee of one sweep to many subscribers: nothing
 * here needs it, and it would put backpressure between unrelated consumers.
 */
export async function streamAllSessions(
  visit: (sessionId: string, turns: UsageTurn[]) => void | Promise<void>,
  options: { includeSidechains?: boolean } = {}
): Promise<void> {
  const project = (turns: UsageTurn[]): UsageTurn[] =>
    options.includeSidechains ? turns : turns.filter((t) => !t.isSidechain);

  const cfg = await readConfig();
  const configKey = sweepConfigKey(cfg);

  const slot = globalForParser.__usageAllSessionsInFlight;
  if (slot && slot.configKey === configKey) {
    const full = await slot.promise;
    for (const [sessionId, turns] of full) {
      const projected = project(turns);
      if (projected.length > 0) await visit(sessionId, projected);
    }
    return;
  }

  const run = sweepGate().then(() =>
    sweepSessions(async (sessionId, turns) => {
      const projected = project(turns);
      if (projected.length > 0) await visit(sessionId, projected);
    })
  );
  setSweepGate(run);
  await run;
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
 * How many JSONL files the cache has successfully read and not since seen
 * removed.
 *
 * The cardinality half of a corpus fingerprint. `getJsonlMaxMtime()` is a
 * MONOTONE summary — it can only answer "has anything newer appeared" — so it
 * is structurally blind to a deletion that does not hold the maximum mtime.
 * Cardinality is the missing dimension: any deletion changes it, whatever the
 * deleted file's age. See #492.
 *
 * **`corpusSize`, not `size`.** Since #476 the cache evicts values under a
 * byte budget, so `size` counts what is RESIDENT while this counts what was
 * READ. Reading the resident count would make a deletion undetectable whenever
 * the deleted file had already been evicted — the #492 defect, reintroduced
 * through the back door by an unrelated change (Codex P2, PR #514).
 *
 * A file whose parse FAILED is not counted, which is what lets a successful
 * retry move this even when the file's mtime is below another's.
 */
export function getJsonlFileCount(): number {
  return getFileCache().corpusSize;
}

/**
 * Source bytes the parse cache is currently charging against its budget.
 *
 * Exposed for tests and metrics, and it is NOT a corpus measure -- unlike
 * the two fingerprint halves above, this deliberately answers "how much is
 * resident". It is how the `weigh` wiring is observable: a transcript the
 * parser declined to parse retains nothing and must charge nothing (#476).
 */
export function getJsonlCacheBytes(): number {
  return getFileCache().bytes;
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
  if (!isValidSessionId(sessionId)) return null;

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
  if (!isValidSessionId(sessionId)) return null;

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
