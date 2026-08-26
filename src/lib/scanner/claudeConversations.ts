import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { decodeDirName } from "../platform";
import {
  ClaudeUsageStats,
  SessionRecap,
  SessionSummary,
  SessionDetail,
  TimelineEvent,
  FileOperation,
  SubagentInfo,
  SessionPermissionMode,
  SessionHookRun,
  SessionHookError,
} from "../types";
import { detectOneShot } from "../usage/oneShotDetector";
import { computeSessionQuality } from "../usage/sessionQuality";
import { classifyTurn } from "../usage/classifier";
import { aggregateWorkMode } from "../usage/workMode";
import { extractPrsFromEntries } from "../usage/prExtractor";
import { extractTicketsFromEntries } from "../usage/ticketExtractor";
import { readSubagentMeta } from "./subagentMeta";
import { enrichSubagentsFromOtel } from "./subagentEnrichment";
import { resolveSessionJsonl } from "../usage/sessionPath";
import { isValidSessionId } from "@/lib/sessionId";
import type { SubagentMeta } from "./subagentMeta";
import type { UsageTurn, ToolCall as UsageToolCall } from "../usage/types";
import {
  loadPricing,
  getModelPricing,
  applyPricing,
  TIER_BOUNDARY,
  type TokenCounts,
} from "../usage/costCalculator";
import { extractCacheCreate1hTokens } from "../usage/cacheTtl";
import {
  readDiskCache,
  writeDiskCache,
  isCacheHit,
  type CachedFileStats,
  type CachedModelBuckets,
} from "../claudeStatsCache";
import { hasUnresolvedToolUse, statusFromPending } from "./sessionStatus";
import { mostFrequent, canonicalizeDirName } from "../usage/parser";
import { isWorktreeEncodedDir } from "./worktreeCheck";
import { FileCache } from "../usage/cache";
import type { SessionFile } from "../adapters/types";
import type { MinderConfig } from "../types";

export interface ConversationEntry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  isMeta?: boolean;
  slug?: string; // present on away_summary entries
  /** Top-level UUID for every JSONL entry (cc-lens schema). */
  uuid?: string;
  /** UUID of the entry this one is replying to. */
  parentUuid?: string;
  /** Claude Code CLI version that wrote this entry. */
  version?: string;
  /** On sidechain entries: the tool_use_id of the Task call that spawned this sidechain. */
  parentToolUseID?: string;

  // ── Fields added by Claude Code ~2.1.212+ (A1) ────────────────────────────
  // Every one is optional and version-dependent: transcripts written by older
  // CLI versions simply lack them. Readers must map absence to `undefined`,
  // never to a default — a turn with no `effort` is not a `medium` turn.

  /**
   * Reasoning effort for this assistant turn. Top-level on the entry, NOT
   * inside `message`. Observed on 10,288 of 10,742 assistant turns in a
   * 1,200-file sample: `high` | `medium` | `xhigh` (`low` is documented but
   * unobserved locally). The turns lacking it are exactly those whose
   * `message.usage.speed` is null.
   */
  effort?: string;
  /**
   * Which skill/MCP server caused this turn's tokens to exist — causal cost
   * attribution, top-level on assistant entries. Semantically distinct from
   * `tool_uses.skill_name`/`mcp_server`, which are *inferred* from the
   * `mcp__server__tool` naming convention and answer "was this call a skill
   * invocation?". Keep the inference for call counts; use these for cost.
   */
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  /** Hook executions attributed to this turn; one-to-many, hence a table not a column. */
  hookInfos?: Array<{ command?: string; durationMs?: number }>;
  /** Sibling of `hookInfos` on the same system entry: plain error strings, not per-hook. */
  hookErrors?: unknown[];
  /** True when a hook blocked the turn from continuing. Present on every hook-carrying entry. */
  preventedContinuation?: boolean;
  /** How the prompt reaching this turn originated: typed | suggestion_accepted | system | queued | sdk. */
  promptSource?: string;
  /** Why a tool call was denied: permission-rule | automode-blocked | user-rejected | automode-unavailable. */
  toolDenialKind?: string;

  // ── Session-shaped fields, carried on `attachment` entries ────────────────
  // These do NOT appear on assistant turns; the session-level readers pick
  // them up from attachments.
  /** Session flavour, e.g. `bg` for a backgrounded session. */
  sessionKind?: string;
  /** How the session was launched: `cli` | `sdk-cli`. */
  entrypoint?: string;

  // ── Payloads of the dedicated entry types (see NEW_ENTRY_TYPES) ───────────
  /** `type: "ai-title"` — model-generated session title. */
  aiTitle?: string;
  /** `type: "permission-mode"` — a permission-mode change, e.g. `auto` | `plan`. */
  permissionMode?: string;
  /** `type: "pr-link"` — authoritative PR linkage, replacing text scraping (A5). */
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  /** `type: "agent-name"` — the name assigned to a spawned agent. */
  agentName?: string;

  message?: {
    model?: string;
    stop_reason?: string;
    role?: string;
    content?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      /** Per-TTL split of `cache_creation_input_tokens`; see `usage/cacheTtl`. */
      cache_creation?: {
        ephemeral_1h_input_tokens?: number;
        ephemeral_5m_input_tokens?: number;
      };
      cache_read_input_tokens?: number;
      /**
       * `standard` | `fast` — fast mode bills at a different rate (Opus 5:
       * $10/$50 vs $5/$25). Present on every assistant turn, but **nullable**:
       * null on the same turns that lack `effort`.
       */
      speed?: string | null;
      service_tier?: string;
    };
  };
  // For tool_result user messages and away_summary system entries
  content?: any;
  /** Duration in ms from system.subtype:turn_duration entries. */
  durationMs?: number;
}

/**
 * Entry `type` values that carry session metadata rather than conversation
 * content. Claude Code emits nine of these that neither reader handled before
 * A1; the four decoded here are the ones with analytic value. The rest —
 * `last-prompt`, `mode`, `queue-operation`, `file-history-delta`,
 * `file-history-snapshot` — are deliberately ignored, but are listed so a
 * future reader knows they exist and were considered rather than missed.
 */
export const DECODED_META_TYPES = [
  "ai-title",
  "permission-mode",
  "pr-link",
  "agent-name",
] as const;

export function encodePath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

export { decodeDirName };

export function toSlug(dirName: string): string {
  // Extract last segment as project name, slugify
  const parts = dirName.split("-");
  // Skip drive letter prefix like "C-"
  const meaningful = parts.slice(parts.findIndex((p) => p.length > 1));
  return meaningful.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function extractTextContent(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && b.text)
    .map((b: any) => b.text)
    .join("\n")
    .slice(0, 200);
}

/**
 * Like extractTextContent but filters out hook/system injection blocks
 * (content starting with '<', e.g. <user-prompt-submit-hook>, <command-name>, etc.)
 */
function extractHumanText(content: any): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.startsWith("<") ? "" : trimmed.slice(0, 200);
  }
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && b.text && !b.text.trim().startsWith("<"))
    .map((b: any) => b.text as string)
    .join("\n")
    .slice(0, 200);
}

// ─── Session ID index (globalThis singleton) ─────────────────────────

const globalForIndex = globalThis as unknown as {
  __sessionIndex?: Map<string, { filePath: string; projectDirName: string }>;
};
const sessionIndex =
  globalForIndex.__sessionIndex ||
  (globalForIndex.__sessionIndex = new Map());

// ─── Lightweight scan for session summaries ───────────────────────────

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * What the per-file cache stores. NOT a `SessionSummary` — see `applyLiveFields`.
 *
 * `summary.status`, `summary.isActive` and `summary.costEstimate` carry
 * placeholder values here. All three depend on state that is NOT part of the
 * cache key — the wall clock for the first two, the active pricing table for
 * the third — so each is re-derived on every read from the inputs kept
 * alongside: `hasPendingTools`, `mtimeMs`, and `perModelTokens`.
 */
interface ScannedSession {
  summary: SessionSummary;
  hasPendingTools: boolean;
  mtimeMs: number;
  /**
   * Per-model token buckets, the file-derived half of the cost calculation.
   * A few numbers per model, so keeping them costs almost nothing next to the
   * summary they sit beside — and it means a pricing change needs no
   * invalidation plumbing at all. (Codex P2, PR #494.)
   */
  perModelTokens: PerModelTokens;
}

// Per-file mtime+size-keyed cache for session summaries (#473).
//
// `scanAllSessions` had no cache at all: measured on a 5,286-session corpus,
// back-to-back calls in one process cost 26.98s cold and 25.96s warm — no reuse
// whatsoever. It serves `/sessions` whenever the list is on file-parse
// (`MINDER_USE_DB=0`, v3 catch-up, an empty index, and — since #472 — the whole
// of the first reconcile), behind a deliberately short 30s route TTL. So that
// walk ran roughly every 30 seconds, competing with the indexer for the same
// files.
//
// The cap is inherited wholesale from `parseAllSessions` (#472): this is an LRU
// over a workload that sweeps every file in the same order every time, which is
// LRU's worst case. Below the corpus size the hit rate does not degrade, it
// collapses to ~0 — a measured 22x there. 25,000 keeps the same headroom over
// the same corpus. A `SessionSummary` is far smaller than the `UsageTurn[]`
// that cache holds (bounded by the 4,000-char `searchableText`), so the memory
// trade is cheaper here than it was there.
const globalForScan = globalThis as unknown as {
  __sessionScanCache?: FileCache<ScannedSession | null>;
};
function getScanCache(): FileCache<ScannedSession | null> {
  if (!globalForScan.__sessionScanCache) {
    globalForScan.__sessionScanCache = new FileCache<ScannedSession | null>({
      maxEntries: 25_000,
    });
  }
  return globalForScan.__sessionScanCache;
}

/** Drop every cached summary. For tests; nothing in `src/` calls it. */
export function clearSessionScanCache(): void {
  getScanCache().clear();
}

/**
 * Number of cached entries. For tests, and specifically for the one covering
 * `retainOnly` — a deleted transcript drops out of the RETURNED list either
 * way, because `readdir` no longer reports it, so the returned list cannot
 * distinguish an evicting cache from a hoarding one. Only the cache's own size
 * can. (Found by mutation: the first version of that test passed with
 * `retainOnly` removed.)
 */
export function sessionScanCacheSize(): number {
  return getScanCache().size;
}

/**
 * Re-derive every field that depends on something outside the cache key.
 *
 * **`status` / `isActive` — the clock.** Both decay monotonically against a
 * FIXED mtime, since the cache key guarantees the file has not been touched, so
 * a warm hit is not approximating anything: `working` really does become
 * `needs_attention` and then `idle` as an abandoned tool call ages, and
 * `isActive` really does fall to false two minutes after the last write.
 * Returning the cached summary verbatim would pin every session to the status
 * it held the first time it was read, and the file stops changing precisely
 * when the session is abandoned — the one case the age thresholds exist to
 * detect.
 *
 * **`costEstimate` — the pricing table.** Same shape, different external input.
 * Editing a custom pricing rule in Settings, or LiteLLM's 24h refresh landing
 * new rates, changes what a transcript costs without changing one byte of it,
 * so a cached cost would survive the change until the session was appended to,
 * evicted, or the process restarted. Uncached, this recomputed on every sweep;
 * caching it would have been a regression this PR introduced. Re-deriving is
 * the fix rather than invalidating from the config route, because the pricing
 * table has more than one writer and only one of them is a config PATCH.
 * (Codex P2, PR #494.)
 *
 * Callers must `await loadPricing()` before this runs — a fully warm sweep
 * parses no file, so nothing else on the path would prime the table.
 *
 * The copy is shallow, so the arrays inside (`toolUsage`, `prs`, `modelsUsed`,
 * `recaps`, …) are shared with the cached entry. Every consumer treats a
 * `SessionSummary` as read-only, and this cache is why that has to stay true:
 * an in-place edit would corrupt the entry for every later reader. Audited at
 * the time of writing — `filterSessions`, `deriveSessionsMaxMs` and the route's
 * `jsonClone` only read, and `scanSessionDetail` (the other caller of
 * `scanSessionFile`, which used to get a freshly built object every time)
 * spreads the summary into its `SessionDetail` and otherwise touches only
 * `summary.sessionId`.
 */
function applyLiveFields(scanned: ScannedSession, now: number): SessionSummary {
  const mtime = new Date(scanned.mtimeMs);
  return {
    ...scanned.summary,
    status: statusFromPending(scanned.hasPendingTools, mtime, now),
    isActive: now - scanned.mtimeMs < 2 * 60_000,
    costEstimate: computeCostFromPerModel(scanned.perModelTokens),
  };
}

/**
 * Cached parse of one transcript. Returns `null` for files that produce no
 * summary — and caches that `null`, so a 60MB transcript costs one `stat` per
 * sweep instead of being re-read and re-rejected every time.
 *
 * **`null` is a verdict about the file; `undefined` is the absence of one.**
 * That distinction is what makes caching `null` safe. `null` means the file was
 * read and is genuinely not a session: oversized, empty, or unparseable. Those
 * answers cannot change while the bytes do not, so remembering them is correct.
 * `undefined` means the read itself failed — a vanished file, `EACCES`,
 * `EBUSY`, `EIO` — which says nothing about the contents, so **nothing is
 * cached** and the next sweep tries again. Conflating the two would make a
 * transient I/O error permanent: restoring permissions typically touches only
 * ctime, so mtime+size are unchanged and a cached `null` would keep the session
 * hidden until its contents changed or the process restarted. Uncached, that
 * error cost one sweep. (Codex P2, PR #494.)
 */
async function scanSessionFileCached(
  filePath: string,
  projectDirName: string
): Promise<ScannedSession | null | undefined> {
  try {
    return await getScanCache().getOrCompute(filePath, () =>
      scanSessionFileRaw(filePath, projectDirName)
    );
  } catch {
    // `getOrCompute` stores nothing when its factory rejects, so the retry is
    // automatic. Swallowing here rather than at the sweep is deliberate: the
    // sweep's own catch is per-DIRECTORY, so letting this escape would drop
    // every session in the folder because one file was briefly locked.
    return undefined;
  }
}

/** Single-file scan through the cache, with the live fields applied. */
async function scanSessionFile(
  filePath: string,
  projectDirName: string
): Promise<SessionSummary | null> {
  const scanned = await scanSessionFileCached(filePath, projectDirName);
  if (!scanned) return null;
  // A cache hit parses nothing, so this is the only thing that primes the
  // pricing table before `applyLiveFields` reads it.
  await loadPricing();
  return applyLiveFields(scanned, Date.now());
}

async function scanSessionFileRaw(
  filePath: string,
  projectDirName: string
): Promise<ScannedSession | null> {
  // Reads sit OUTSIDE the catch below on purpose, so an I/O error propagates
  // as a rejection instead of being laundered into a cacheable `null`. See the
  // `scanSessionFileCached` docstring: the catch below answers "is this file a
  // session?", and only an answer derived from the bytes may be remembered.
  const stat = await fs.stat(filePath);
  const mtime = stat.mtime;
  // Oversized IS a verdict — the bytes were consulted, the file is deliberately
  // not parsed, and that stays true until the size changes. Cacheable.
  if (stat.size > MAX_SESSION_FILE_SIZE) return null;
  const content = await fs.readFile(filePath, "utf-8");

  try {
    const canonicalDirName = canonicalizeDirName(projectDirName);
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const sessionId = path.basename(filePath, ".jsonl");
    let startTime: string | undefined;
    let endTime: string | undefined;
    let initialPrompt: string | undefined;
    let lastPrompt: string | undefined;
    let gitBranch: string | undefined;
    let sessionSlug: string | undefined;
    const recaps: SessionRecap[] = [];
    let messageCount = 0;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    const tools: Record<string, number> = {};
    const skills: Record<string, number> = {};
    const models = new Set<string>();
    let subagentCount = 0;
    let errorCount = 0;
    // A1: fields from Claude Code's newer entry types. Each stays `undefined`
    // rather than defaulting, so a pre-2.1.212 transcript is distinguishable
    // from one that genuinely had no title / never switched permission mode.
    let aiTitle: string | undefined;
    let sessionKind: string | undefined;
    let entrypoint: string | undefined;
    const permissionModes: SessionPermissionMode[] = [];
    const hookRuns: SessionHookRun[] = [];
    const hookErrors: SessionHookError[] = [];
    const effortMix: Record<string, number> = {};
    // Per-model token accumulation for accurate cost (via LiteLLM pricing)
    const perModelTokens: PerModelTokens = new Map();
    const allEntries: ConversationEntry[] = [];
    const searchParts: string[] = [];
    let searchLen = 0;
    // Collect one-shot detection data during the same pass
    const lightTurns: UsageTurn[] = [];
    // A3: propagate the most-recent primary user prompt onto following assistant
    // turns so `classifyTurn` attributes intent — mirrors the DB ingest path so
    // the per-session workMode (and any category-derived view) agrees across
    // backends. Only primary (non-sidechain) user turns move the intent; the
    // whole lightTurns block below is already gated on `!entry.isSidechain`.
    let prevUserText: string | undefined;

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);
        allEntries.push(entry);

        if (entry.timestamp) {
          if (!startTime) startTime = entry.timestamp;
          endTime = entry.timestamp;
        }
        if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;

        if (entry.type === "system" && entry.subtype === "away_summary" && typeof entry.content === "string" && entry.timestamp) {
          recaps.push({ content: entry.content, timestamp: entry.timestamp, slug: entry.slug });
        }

        // A6: hook telemetry rides SYSTEM entries — 4,189 of 4,189 carriers on
        // the local corpus, none on assistant. This decode used to live inside
        // the `entry.type === "assistant"` branch below, next to `effort` and
        // `message.usage`, so it never saw a single one. Both readers had the
        // same wrong idea about where the field lives, which is why the DB
        // backend's `session_hook_runs` and the file backend's `hookRuns` were
        // *consistently* empty — parity held, at zero.
        //
        // `durationMs` stays undefined when unmeasured (4,189 of 20,284
        // records) rather than collapsing to 0, which would rank an unmeasured
        // hook as the fastest.
        if (Array.isArray(entry.hookInfos)) {
          for (const h of entry.hookInfos) {
            if (h && typeof h.command === "string" && h.command) {
              hookRuns.push({
                ts: entry.timestamp,
                command: h.command,
                durationMs: typeof h.durationMs === "number" ? h.durationMs : undefined,
              });
            }
          }
        }
        if (Array.isArray(entry.hookErrors)) {
          const blocked = entry.preventedContinuation === true;
          for (const msg of entry.hookErrors) {
            if (typeof msg === "string" && msg) {
              hookErrors.push({ ts: entry.timestamp, message: msg, preventedContinuation: blocked });
            }
          }
        }

        // A1: dedicated metadata entry types. These carry no `message` and were
        // previously dropped on the floor by both readers' type switches.
        switch (entry.type) {
          case "ai-title":
            // Re-emitted as the session's subject clarifies; last one wins.
            if (typeof entry.aiTitle === "string" && entry.aiTitle) aiTitle = entry.aiTitle;
            break;
          case "permission-mode":
            if (typeof entry.permissionMode === "string" && entry.permissionMode) {
              permissionModes.push({ ts: entry.timestamp, mode: entry.permissionMode });
            }
            break;
          // NOTE: `pr-link` is handled by `extractPrsFromEntries`, not here —
          // it needs to merge with the `gh pr create` scraper's finds, and
          // doing that in one shared place is what makes the DB path see it too.
          case "attachment":
            // Session-shaped metadata rides attachments, not assistant turns.
            // First non-empty wins — these are constant for a session, and
            // latching early avoids a late malformed entry overwriting them.
            if (!sessionKind && typeof entry.sessionKind === "string" && entry.sessionKind) {
              sessionKind = entry.sessionKind;
            }
            if (!entrypoint && typeof entry.entrypoint === "string" && entry.entrypoint) {
              entrypoint = entry.entrypoint;
            }
            break;
        }

        if (entry.type === "user" && !entry.isMeta) {
          userMessageCount++;
          messageCount++;
          const humanContent = entry.message?.content ?? entry.content;
          const humanText = extractHumanText(humanContent);
          if (humanText) {
            if (!initialPrompt) initialPrompt = humanText;
            lastPrompt = humanText;
            if (searchLen < 4000) { searchParts.push(humanText); searchLen += humanText.length; }
          }
        }

        if (entry.type === "assistant" && entry.message) {
          assistantMessageCount++;
          messageCount++;
          // Capture Claude Code's stable session slug here, restricted
          // to assistant entries — out-of-band records (system, recap)
          // can carry slug fields too, and latching from one of those
          // would permanently poison `sessions.slug` for this session.
          if (!sessionSlug && typeof entry.slug === "string" && entry.slug.length > 0) {
            sessionSlug = entry.slug;
          }
          const msg = entry.message;
          const model = msg.model;
          if (model && model !== "<synthetic>") models.add(model);

          // A1: only count turns that actually carried an effort. The mix
          // deliberately does not sum to assistantMessageCount — the shortfall
          // is turns from before the field existed, and inventing a bucket for
          // them would make a pre-2.1.212 session look uniformly one effort.
          if (typeof entry.effort === "string" && entry.effort) {
            effortMix[entry.effort] = (effortMix[entry.effort] || 0) + 1;
          }
          const usage = msg.usage;
          if (usage) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cc  = usage.cache_creation_input_tokens || 0;
            const cc1h = extractCacheCreate1hTokens(usage) ?? 0;
            const cr  = usage.cache_read_input_tokens || 0;
            inputTokens += inp;
            outputTokens += out;
            cacheCreateTokens += cc;
            cacheReadTokens += cr;
            // `speed` matters here for the same reason it does in
            // `scanConversationFile`: this path computes the session list's own
            // `costEstimate`, so omitting it would price a fast turn at half
            // rate on `/sessions` while the aggregate scanner and the SQLite
            // backend both price it correctly — a backend disagreement visible
            // only by comparing two screens.
            accumulateTurn(
              perModelTokens, model, inp, out, cc, cr, cc1h,
              (usage as { speed?: string }).speed,
            );
          }

          if (entry.isApiErrorMessage) errorCount++;

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                tools[block.name] = (tools[block.name] || 0) + 1;
                if (block.name === "Agent") subagentCount++;
                if (block.name === "Skill" && block.input?.skill) {
                  const skillName = block.input.skill;
                  skills[skillName] = (skills[skillName] || 0) + 1;
                }
              } else if (block.type === "text" && block.text && !entry.isSidechain) {
                if (searchLen < 4000) {
                  const t = String(block.text).slice(0, 500);
                  searchParts.push(t);
                  searchLen += t.length;
                }
              }
            }
          }
        }

        // Build lightweight turn for one-shot detection (same pass, no re-parse).
        // Skip synthetic-model assistant entries to match `parseSessionTurns`
        // and DB ingest behavior; without this filter the file-parse path's
        // sessionQuality output would diverge from the DB path's for any
        // session containing synthetic turns. Reviewer (Copilot) flagged.
        const isSyntheticAssistant =
          entry.type === "assistant" &&
          (!entry.message?.model || entry.message.model === "<synthetic>");
        if (entry.timestamp && !entry.isSidechain && !entry.isMeta && !isSyntheticAssistant) {
          const turnToolCalls: UsageToolCall[] = [];
          let toolResultText = "";

          if (entry.type === "assistant" && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === "tool_use" && block.name) {
                turnToolCalls.push({ name: block.name, arguments: block.input });
              }
            }
          }
          if (entry.type === "user") {
            const content = entry.message?.content || entry.content || [];
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  if (typeof block.content === "string") toolResultText += block.content;
                  else if (Array.isArray(block.content)) {
                    for (const c of block.content) {
                      if (c.type === "text" && c.text) toolResultText += c.text;
                    }
                  }
                }
              }
            }
            // A3 intent tracking — same source selection as the DB ingest path
            // (`message.content` if present, else top-level `content`; raw string
            // or array-extracted text), so both backends classify identically.
            const uMsg: unknown = entry.message?.content ?? [];
            const uTop: unknown = entry.content ?? [];
            const uMsgLen = typeof uMsg === "string" ? uMsg.length : Array.isArray(uMsg) ? uMsg.length : 0;
            const uSource = uMsgLen > 0 ? uMsg : uTop;
            const uText = typeof uSource === "string" ? uSource : extractTextContent(uSource as any[]);
            if (uText) prevUserText = uText.slice(0, 500); // matches parser/ingest cap
          }

          // Token fields populated for assistant turns (used by
          // sessionQuality detectors to compute fill/cache stats). User
          // turns leave them at 0; the detectors already gate on
          // role==="assistant" before reading. Keeping the gate
          // role-based avoids re-walking JSONL for the quality pass.
          const turnUsage = entry.type === "assistant" ? entry.message?.usage : undefined;
          const turnIsError =
            entry.type === "assistant" && entry.isApiErrorMessage === true;
          lightTurns.push({
            timestamp: entry.timestamp,
            sessionId,
            projectSlug: toSlug(canonicalDirName),
            projectDirName: canonicalDirName,
            model: entry.message?.model || "",
            role: entry.type === "assistant" ? "assistant" : "user",
            inputTokens: turnUsage?.input_tokens ?? 0,
            outputTokens: turnUsage?.output_tokens ?? 0,
            cacheCreateTokens: turnUsage?.cache_creation_input_tokens ?? 0,
            cacheCreate1hTokens: extractCacheCreate1hTokens(turnUsage),
            cacheReadTokens: turnUsage?.cache_read_input_tokens ?? 0,
            // A1: `speed` is nullable in the transcript (null on the same turns
            // that lack `effort`), and `UsageTurn.speed` is `string | undefined`
            // — so normalise null to undefined rather than widening the type.
            // Both mean "unknown"; neither means "standard".
            effort: entry.effort,
            speed: turnUsage?.speed ?? undefined,
            attributionSkill: entry.attributionSkill,
            attributionMcpServer: entry.attributionMcpServer,
            attributionMcpTool: entry.attributionMcpTool,
            toolCalls: turnToolCalls,
            toolResultText: toolResultText.slice(0, 2000),
            isError: turnIsError,
            // A3: only meaningful on assistant turns (classifyTurn reads it);
            // harmless on user turns, whose category is never consumed.
            userIntentText: entry.type === "assistant" ? prevUserText : undefined,
          });
        }
      } catch {
        // Skip invalid lines
      }
    }

    if (messageCount === 0) return null;

    let oneShotRate: number | undefined;
    try {
      const oneShotStats = detectOneShot(lightTurns);
      if (oneShotStats.totalVerifiedTasks > 0) {
        oneShotRate = oneShotStats.rate;
      }
    } catch { /* non-critical */ }

    // Quality detectors (#100/#102/#104) run on the same lightTurns the
    // one-shot detector already used. Falls back to undefined fields on
    // failure so the file-parse SessionsBrowser badges simply don't
    // render rather than poisoning the summary.
    let qualityCacheHitRatio: number | undefined;
    let qualityMaxContextFill: number | undefined;
    let qualityHasCompactionLoop: boolean | undefined;
    let qualityHasToolFailureStreak: boolean | undefined;
    try {
      const quality = computeSessionQuality(lightTurns);
      if (quality.cache.hitRatio !== null) qualityCacheHitRatio = quality.cache.hitRatio;
      if (quality.maxContextFill > 0) qualityMaxContextFill = quality.maxContextFill;
      qualityHasCompactionLoop = quality.compactionLoops.length > 0;
      qualityHasToolFailureStreak = quality.toolFailureStreaks.length > 0;
    } catch { /* non-critical */ }

    // Work-mode distribution: classify each assistant turn and aggregate.
    let sessionWorkMode: SessionSummary["workMode"] | undefined;
    try {
      const categories = lightTurns
        .filter((t) => t.role === "assistant")
        .map((t) => ({ category: classifyTurn(t) }));
      sessionWorkMode = aggregateWorkMode(categories);
    } catch { /* non-critical */ }

    // PR extraction (T2.2). Walks the already-parsed entries once more
    // looking for `gh pr create` Bash invocations matched to their
    // tool_result by `tool_use_id`. Defensive try/catch so a parse hiccup
    // never poisons the rest of the SessionSummary.
    let prs: SessionSummary["prs"] | undefined;
    try {
      // `extractPrsFromEntries` folds the authoritative `type: "pr-link"`
      // entries in with the `gh pr create` scraper itself, so both this reader
      // and the DB ingest path get them from one place.
      const found = extractPrsFromEntries(allEntries);
      if (found.length > 0) prs = found;
    } catch { /* non-critical */ }

    // Ticket extraction (item 3). Scans all text blocks for full
    // Linear/Jira/GitHub-issue URLs — no tool_use_id pairing. Same
    // defensive posture: a hiccup must not poison the SessionSummary.
    let tickets: SessionSummary["tickets"] | undefined;
    try {
      const found = extractTicketsFromEntries(allEntries);
      if (found.length > 0) tickets = found;
    } catch { /* non-critical */ }

    // Per-model cost calculation using LiteLLM pricing (unified with /usage).
    // Placeholder, like `status` below: `applyLiveFields` recomputes it on every
    // read so a pricing change is picked up without touching the transcript.
    await loadPricing();
    const costEstimate = computeCostFromPerModel(perModelTokens);

    // Only the cacheable half runs here. `status` and `isActive` below are
    // placeholders — `applyLiveFields` overwrites both on every read, warm or
    // cold, so the two paths cannot drift apart.
    const hasPendingTools = hasUnresolvedToolUse(
      allEntries.length > 500 ? allEntries.slice(-500) : allEntries,
    );
    const status = statusFromPending(hasPendingTools, mtime);
    const isActive = Date.now() - mtime.getTime() < 2 * 60_000;
    const durationMs =
      startTime && endTime
        ? new Date(endTime).getTime() - new Date(startTime).getTime()
        : undefined;

    const projectPath = decodeDirName(canonicalDirName);
    const projectSlug = toSlug(canonicalDirName);

    const summary: SessionSummary = {
      sessionId,
      projectPath,
      projectSlug,
      projectName: projectDirName,
      startTime,
      endTime,
      durationMs,
      initialPrompt,
      lastPrompt: lastPrompt !== initialPrompt ? lastPrompt : undefined,
      recaps: recaps.length > 0 ? recaps : undefined,
      messageCount,
      userMessageCount,
      assistantMessageCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costEstimate,
      toolUsage: tools,
      modelsUsed: Array.from(models),
      gitBranch,
      subagentCount,
      errorCount,
      isActive,
      status,
      skillsUsed: skills,
      oneShotRate,
      searchableText: searchParts.join(" ").slice(0, 4000),
      slug: sessionSlug,
      // continuedFromSessionId is intentionally omitted on the file-parse
      // path: linking sessions by slug requires visibility into the rest
      // of the corpus, which we'd have to second-pass to compute. The DB
      // path's batched UPDATE is the canonical source. File-parse mode
      // (`MINDER_USE_DB=0`) just shows the slug without a "continued
      // from" badge — degraded but never wrong.
      cacheHitRatio: qualityCacheHitRatio,
      maxContextFill: qualityMaxContextFill,
      hasCompactionLoop: qualityHasCompactionLoop,
      hasToolFailureStreak: qualityHasToolFailureStreak,
      workMode: sessionWorkMode,
      isWorktree: isWorktreeEncodedDir(projectDirName),
      source: "claude",
      prs,
      tickets,
      // A1: empty collections collapse to `undefined` so "no permission-mode
      // changes recorded" and "this transcript predates the entry type" stay
      // indistinguishable at the type level — which they are, and pretending
      // otherwise would let a UI report `0 mode switches` for a session that
      // simply could not have reported any.
      sessionKind,
      entrypoint,
      aiTitle,
      permissionModes: permissionModes.length > 0 ? permissionModes : undefined,
      effortMix: Object.keys(effortMix).length > 0 ? effortMix : undefined,
      hookRuns: hookRuns.length > 0 ? hookRuns : undefined,
      hookErrors: hookErrors.length > 0 ? hookErrors : undefined,
    };

    return { summary, hasPendingTools, mtimeMs: mtime.getTime(), perModelTokens };
  } catch {
    return null;
  }
}

/**
 * Scan all sessions across all projects. Returns lightweight summaries.
 */
export async function scanAllSessions(): Promise<SessionSummary[]> {
  // Sweep every readable Claude home, not just the primary tree — the same
  // set the indexer walks and the same set `parseAllSessions` and
  // `scanClaudeConversationsForProjects` already sweep. This scanner was the
  // last one still hard-coded to `os.homedir()`, so a secondary or WSL home's
  // sessions were missing from the list whenever it served: under
  // `MINDER_USE_DB=0`, during v3 catch-up, on an empty index — and, once #472
  // began diverting here, for the whole of the first reconcile. A fallback
  // that cannot see the same corpus as the path it replaces is not a fallback.
  // (Codex P1, PR #474.)
  const { readConfig } = await import("../config");
  const { getReadableClaudeHomes } = await import("../claudeHome");
  const config = await readConfig();
  const homes = await getReadableClaudeHomes(config);

  // Before the sweep, not inside it: a fully warm sweep parses no file, and the
  // per-file parse is what used to prime this. `applyLiveFields` reads the
  // pricing table for every session, warm or cold.
  await loadPricing();

  const sessions: SessionSummary[] = [];
  // Every transcript path this sweep actually looked at, across ALL homes.
  // Pruning per-home would let the second home's entries evict the first's.
  const liveSet = new Set<string>();
  // One clock reading for the whole sweep, so two sessions that are equally
  // stale cannot be reported with different statuses because the walk between
  // them took time.
  const now = Date.now();

  for (const home of homes) {
    const projectsDir = path.join(home, "projects");
    let dirs: string[];
    try {
      dirs = await fs.readdir(projectsDir);
    } catch {
      // No projects tree in this home — the next one may still have one.
      continue;
    }
    await scanOneHome(projectsDir, dirs, sessions, liveSet, now);
  }

  // Non-Claude harnesses, merged the way `mergeAdapterSessions` merges into
  // `buildAllSessions` (#489). Runs INSIDE the sweep so its files land in
  // `liveSet` before the prune below — an adapter path missing from that set
  // would be evicted on every pass and re-parsed on the next.
  await mergeAdapterSessionSummaries(config, sessions, liveSet, now);

  // Drop cached summaries for transcripts that are gone — deleted, or no longer
  // under any readable home after a config change. Without this a removed home
  // keeps paying LRU rent, and `maxMtimeMs()` would keep reporting a file that
  // no longer exists.
  getScanCache().retainOnly(liveSet);

  // Sort by most recent activity (endTime) so active sessions appear first
  sessions.sort((a, b) => {
    const ta = a.endTime ? new Date(a.endTime).getTime() : 0;
    const tb = b.endTime ? new Date(b.endTime).getTime() : 0;
    return tb - ta;
  });

  return sessions;
}

/**
 * Derive a `SessionSummary` for one non-Claude adapter session (#489).
 *
 * **Shares the content derivation with ingest rather than re-implementing it.**
 * `buildAdapterParsedSession` is the converter the SQLite path already runs on
 * exactly these `UsageTurn[]`, so token totals, turn counts, prompts,
 * categories, work mode and one-shot detection are produced by one function for
 * both backends. Writing a second derivation that agreed by inspection is the
 * failure class #483 was: five hand-copied predicates that matched perfectly
 * and were wrong together.
 *
 * The import is dynamic and has to be: `db/ingest.ts` imports `toSlug` and
 * `ConversationEntry` from THIS module, so a static import would close the
 * cycle at module-evaluation time. It is also safe without `better-sqlite3` —
 * `ingest.ts` names it in a type-only import and opens no connection at module
 * scope — which matters because this path is exactly the one that runs under
 * `MINDER_USE_DB=0`.
 *
 * What is NOT shared is the `ParsedSession` -> `SessionSummary` field mapping,
 * which mirrors `loadSessionsListFromDb`'s. That one really is agreement by
 * inspection, and it is held there by a dual-backend parity test that puts the
 * same fixture through both loaders and compares field by field, rather than by
 * this comment.
 */
async function buildAdapterScannedSession(
  file: SessionFile,
  turns: UsageTurn[],
  mtimeMs: number,
  fileSize: number
): Promise<ScannedSession | null> {
  const { buildAdapterParsedSession } = await import("@/lib/db/ingest");
  const parsed = buildAdapterParsedSession(file, turns, mtimeMs, fileSize);
  if (!parsed) return null;

  const toolUsage: Record<string, number> = {};
  const skillsUsed: Record<string, number> = {};
  const models = new Set<string>();
  const searchParts: string[] = [];
  const perModelTokens: PerModelTokens = new Map();

  for (const turn of parsed.turns) {
    for (const tu of turn.toolUses) {
      toolUsage[tu.toolName] = (toolUsage[tu.toolName] ?? 0) + 1;
      if (tu.skillName) skillsUsed[tu.skillName] = (skillsUsed[tu.skillName] ?? 0) + 1;
    }
    if (turn.textPreview) searchParts.push(turn.textPreview);
    if (turn.role !== "assistant") continue;
    if (turn.model) models.add(turn.model);
    const u = turn.usageTurn;
    // The SAME accumulator the Claude sweep uses, so the two share one tier
    // decision. `applyPricing`'s `auto` rule is re-implemented nowhere.
    accumulateTurn(
      perModelTokens,
      turn.model ?? undefined,
      u.inputTokens, u.outputTokens, u.cacheCreateTokens, u.cacheReadTokens,
      u.cacheCreate1hTokens ?? 0,
      u.speed,
    );
  }

  const canonicalDirName = canonicalizeDirName(parsed.projectDirName);
  const durationMs =
    parsed.startTs && parsed.endTs
      ? new Date(parsed.endTs).getTime() - new Date(parsed.startTs).getTime()
      : undefined;

  const summary: SessionSummary = {
    sessionId: parsed.sessionId,
    projectPath: decodeDirName(canonicalDirName),
    projectSlug: parsed.projectSlug,
    projectName: parsed.projectDirName,
    startTime: parsed.startTs ?? undefined,
    endTime: parsed.endTs ?? undefined,
    durationMs,
    initialPrompt: parsed.initialPrompt ?? undefined,
    // Same suppression both other loaders apply, so a single-prompt session
    // does not render the same text twice.
    lastPrompt:
      parsed.lastPrompt && parsed.lastPrompt !== parsed.initialPrompt
        ? parsed.lastPrompt
        : undefined,
    messageCount: parsed.turnCount,
    userMessageCount: parsed.userTurnCount,
    assistantMessageCount: parsed.assistantTurnCount,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheCreateTokens: parsed.cacheCreateTokens,
    // Placeholder — `applyLiveFields` reprices from `perModelTokens` on every
    // read, the same as a Claude entry. Freezing an adapter cost here would
    // re-arm the pricing defect fixed on PR #494 one merge over.
    costEstimate: 0,
    toolUsage,
    modelsUsed: Array.from(models),
    gitBranch: undefined,
    // `toolUsage["Agent"]` rather than a sidechain walk, matching the DB
    // mapper. No adapter emits sidechain turns today, so both read 0 unless
    // the harness itself reports an Agent call.
    subagentCount: toolUsage["Agent"] ?? 0,
    errorCount: parsed.errorCount,
    // Placeholders, as on the Claude path.
    isActive: false,
    status: "idle",
    skillsUsed,
    oneShotRate:
      parsed.verifiedTaskCount > 0
        ? parsed.oneShotTaskCount / parsed.verifiedTaskCount
        : undefined,
    searchableText: searchParts.join(" ").slice(0, 4000),
    cacheHitRatio: parsed.cacheHitRatio ?? undefined,
    // All-or-nothing, as in the DB mapper: a partial work-mode split would
    // render as a bar that does not sum to 100.
    workMode:
      parsed.workModeExplorationPct !== null &&
      parsed.workModeBuildingPct !== null &&
      parsed.workModeTestingPct !== null &&
      parsed.workModeOtherPct !== null
        ? {
            exploration: parsed.workModeExplorationPct,
            building: parsed.workModeBuildingPct,
            testing: parsed.workModeTestingPct,
            other: parsed.workModeOtherPct,
          }
        : undefined,
    isWorktree: isWorktreeEncodedDir(parsed.projectDirName),
    source: file.source,
  };

  return {
    summary,
    // **Always false, and that is a match rather than a shortcut.** Ingest
    // stores `storedStatus: "inactive"` for every adapter session, and
    // `computeStatus("inactive", …)` returns `idle` unconditionally — so the
    // DB backend never shows a Codex session as `working`. `hasPendingTools:
    // false` produces exactly that through `statusFromPending`, which is the
    // point: `status` is the first field a user looks at, and deriving it one
    // way here and another there would be a per-backend disagreement on it.
    hasPendingTools: false,
    mtimeMs,
    perModelTokens,
  };
}

/**
 * Sweep every enabled non-Claude adapter and append its sessions (#489).
 *
 * Closes the last half of #475: `getSessionsList` was the only loader whose
 * file path could not see the whole corpus, which is why `fileParseCoversCorpus`
 * existed and why an adapter user kept the #472 defect on the session list.
 *
 * Deliberately mirrors `mergeAdapterSessions` in `usage/parser.ts` rather than
 * inventing a second policy — same enabled-adapter filter, same batch size,
 * same size cap, same containment, same id rule:
 *
 *   - **`a.id !== "claude"`.** The Claude corpus was already swept above by the
 *     home walk; running the Claude adapter here would double every session.
 *   - **Failures are contained per adapter AND per file.** A harness whose
 *     `discover()` throws must not take the other harnesses — or the Claude
 *     sessions already collected — down with it.
 *   - **`MAX_SESSION_FILE_SIZE`.** `reconcileAdapterSessionFile` SKIPS oversized
 *     files on the SQL side, so parsing them here would make the fallback
 *     include sessions the index deliberately excludes — a fresh divergence
 *     introduced by the change closing one.
 *   - **Keyed on the id the turns carry**, never the filename. Codex reads its
 *     id from `session_meta` and falls back to the basename only when that is
 *     absent, so a basename key would disagree with the id ingest stores —
 *     which is what any "same corpus" claim rests on.
 *
 * **Adapter files are NOT registered in `sessionIndex`, on purpose.** That index
 * feeds `scanSessionDetail`, which parses Claude JSONL entries; handing it a
 * Codex event stream would not fail loudly, it would render a plausible empty
 * detail view. Unregistered, the detail route falls through to
 * `resolveSessionJsonl` (Claude homes only) and 404s, which is the honest
 * degrade. A real adapter detail view needs a per-harness parser and is out of
 * scope here.
 */
async function mergeAdapterSessionSummaries(
  config: MinderConfig,
  sessions: SessionSummary[],
  liveSet: Set<string>,
  now: number
): Promise<void> {
  const { getEnabledAdapters } = await import("@/lib/adapters");
  const adapters = getEnabledAdapters(config).filter((a) => a.id !== "claude");
  if (adapters.length === 0) return;

  // Claude wins a collision, matching `mergeAdapterSessions`. Built once here
  // rather than per adapter so a later adapter cannot overwrite an earlier one
  // either.
  const seen = new Set(sessions.map((s) => s.sessionId));

  for (const adapter of adapters) {
    let files: SessionFile[];
    try {
      files = await adapter.discover();
    } catch {
      continue;
    }

    for (let i = 0; i < files.length; i += 5) {
      const batch = files.slice(i, i + 5);
      const scanned = await Promise.all(
        batch.map(async (file) => {
          liveSet.add(file.filePath);
          try {
            return await getScanCache().getOrCompute(file.filePath, async (fp) => {
              const stat = await fs.stat(fp);
              if (stat.size > MAX_SESSION_FILE_SIZE) return null;
              const turns = await adapter.parseFile(file);
              if (turns.length === 0) return null;
              return buildAdapterScannedSession(
                file, turns, stat.mtimeMs, stat.size
              );
            });
          } catch {
            // Same contract as the Claude path: an I/O or parse failure is not
            // a verdict about the file, so `getOrCompute` cached nothing and
            // the next sweep retries. (#494.)
            return undefined;
          }
        })
      );

      for (const r of scanned) {
        if (!r) continue;
        if (seen.has(r.summary.sessionId)) continue;
        seen.add(r.summary.sessionId);
        sessions.push(applyLiveFields(r, now));
      }
    }
  }
}

async function scanOneHome(
  projectsDir: string,
  dirs: string[],
  sessions: SessionSummary[],
  liveSet: Set<string>,
  now: number
): Promise<void> {
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const entries = await fs.readdir(dirPath);
      const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));

      // Process in batches of 5
      for (let i = 0; i < jsonlFiles.length; i += 5) {
        const batch = jsonlFiles.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (f) => {
            const filePath = path.join(dirPath, f);
            // No `stat` here: the cache stats every file itself, and on a warm
            // hit that single stat IS the whole cost of the file. Statting it
            // again out here would double the syscall count of a warm sweep,
            // which is the only cost a warm sweep has left.
            liveSet.add(filePath);
            return scanSessionFileCached(filePath, dir);
          })
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r) {
            sessions.push(applyLiveFields(r, now));
            // Populate session index for fast detail lookups. Runs on warm hits
            // too — a cached summary still has to be resolvable by id.
            const fileName = batch[j];
            sessionIndex.set(
              r.summary.sessionId,
              { filePath: path.join(dirPath, fileName), projectDirName: dir }
            );
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }
}

// ─── Detailed session scan (timeline, files, subagents) ─────────────

const FILE_TOOL_OPERATIONS: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
};

/**
 * Full parse of a single session JSONL file for the detail view.
 */
export async function scanSessionDetail(
  sessionId: string
): Promise<SessionDetail | null> {
  // Validate sessionId to prevent path traversal. Shared with every other
  // gate (#483) — the copies of this literal are what silently excluded
  // `agent-<hex>` subagent sessions from all five of them at once.
  if (!isValidSessionId(sessionId)) {
    return null;
  }

  // Check session index first (populated by scanAllSessions)
  let filePath: string | null = null;
  let projectDirName = "";
  const indexed = sessionIndex.get(sessionId);
  if (indexed) {
    filePath = indexed.filePath;
    projectDirName = indexed.projectDirName;
  } else {
    // Fallback: shared session-id → jsonl resolver. Walks
    // ~/.claude/projects/<dir>/<sessionId>.jsonl until the first match.
    // The resolver throws on non-ENOENT fs errors (EACCES, EBUSY,
    // etc.); the previous inline fallback swallowed all such errors and
    // returned null. Preserve that detail-loader contract so a
    // permissions glitch turns into a "session not available" 404
    // rather than a 500 from the API route.
    try {
      const resolved = await resolveSessionJsonl(sessionId);
      if (resolved) {
        filePath = resolved.filePath;
        projectDirName = resolved.projectDirName;
      }
    } catch {
      return null;
    }
  }

  if (!filePath) return null;

  const fstat = await fs.stat(filePath);
  if (fstat.size > MAX_SESSION_FILE_SIZE) return null;
  const summary = await scanSessionFile(filePath, projectDirName);
  if (!summary) return null;

  // Now do the detailed parse for timeline, file ops, subagents
  const timeline: TimelineEvent[] = [];
  const fileOperations: FileOperation[] = [];
  const subagentMap = new Map<string, SubagentInfo>();
  const subagentMetaMap = await readSubagentMeta(filePath);

  let hasThinking = false;
  const versionCounts = new Map<string, number>();
  // Index into timeline[] of the most recently pushed assistant event.
  // Used to attach turn_duration without following parentUuid (which points
  // at stop_hook_summary, not the assistant turn).
  let lastAssistantTimelineIdx = -1;

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);

        // Collect CLI version for every entry that carries it.
        if (typeof entry.version === "string" && entry.version) {
          versionCounts.set(entry.version, (versionCounts.get(entry.version) ?? 0) + 1);
        }

        // turn_duration system entry: attach to the nearest preceding assistant event.
        if (
          entry.type === "system" &&
          entry.subtype === "turn_duration" &&
          typeof (entry as any).duration === "number" &&
          lastAssistantTimelineIdx >= 0
        ) {
          timeline[lastAssistantTimelineIdx].durationMs = (entry as any).duration;
          continue;
        }

        if (entry.type === "user" && !entry.isMeta && !entry.isSidechain) {
          const text = entry.message?.content
            ? extractTextContent(entry.message.content)
            : Array.isArray(entry.content)
              ? extractTextContent(entry.content)
              : "";
          if (text) {
            timeline.push({
              type: "user",
              timestamp: entry.timestamp,
              content: text,
            });
          }
        }

        // Process sidechain assistant entries for subagent stats.
        // Historical: this path used `parentToolUseID` to link tool calls to
        // their parent Agent dispatch. As of Claude Code ~v2.1.150 the JSONL
        // schema no longer carries sidechain assistant entries in the parent
        // session's file (probed 2026-05-25: 0/214 sessions had isSidechain
        // assistants). Per-subagent runtime metrics now come from the OTEL
        // `subagent_completed` + `api_request` events via the enrichment
        // step in `enrichSubagentsFromOtel`. Kept here for any session JSONL
        // that still includes the old schema — does no harm when empty.
        if (entry.type === "assistant" && entry.message && entry.isSidechain) {
          const msg = entry.message;
          const parentId = (entry as any).parentToolUseID;
          if (parentId && subagentMap.has(parentId)) {
            const agent = subagentMap.get(parentId)!;
            // `?? 0` is right *here* and wrong on the DB path: this backend
            // walks the sidechain entries, so it starts at a real zero and
            // counts up. The DB path cannot count at all and leaves the field
            // undefined rather than claiming zero (see SubagentInfo).
            agent.messageCount = (agent.messageCount ?? 0) + 1;
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "tool_use" && block.name) {
                  agent.toolUsage[block.name] = (agent.toolUsage[block.name] || 0) + 1;
                }
              }
            }
          }
          continue;
        }

        if (entry.type === "assistant" && entry.message && !entry.isSidechain) {
          const msg = entry.message;
          lastAssistantTimelineIdx = -1;

          if (entry.isApiErrorMessage) {
            const errorText = extractTextContent(msg.content || []);
            timeline.push({
              type: "error",
              timestamp: entry.timestamp,
              content: errorText || "API error",
            });
            continue;
          }

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "thinking" && block.thinking) {
                hasThinking = true;
                timeline.push({
                  type: "thinking",
                  timestamp: entry.timestamp,
                  content: String(block.thinking).slice(0, 3000),
                });
              } else if (block.type === "text" && block.text) {
                lastAssistantTimelineIdx = timeline.length;
                timeline.push({
                  type: "assistant",
                  timestamp: entry.timestamp,
                  content: String(block.text).slice(0, 300),
                  tokenCount:
                    (msg.usage?.output_tokens || 0) > 0
                      ? msg.usage!.output_tokens
                      : undefined,
                });
              } else if (block.type === "tool_use") {
                const toolName = block.name || "unknown";
                const input = block.input || {};

                // Timeline event
                let summary = toolName;
                if (input.file_path) summary = `${toolName}: ${input.file_path}`;
                else if (input.command) summary = `${toolName}: ${String(input.command).slice(0, 100)}`;
                else if (input.pattern) summary = `${toolName}: ${input.pattern}`;
                else if (input.prompt) summary = `${toolName}: ${String(input.prompt).slice(0, 100)}`;
                else if (input.description) summary = `${toolName}: ${String(input.description).slice(0, 100)}`;

                timeline.push({
                  type: "tool_use",
                  timestamp: entry.timestamp,
                  content: summary,
                  toolName,
                  toolUseId: block.id as string | undefined,
                  toolInput: Object.keys(input).length > 0 ? (input as Record<string, unknown>) : undefined,
                });

                // File operations
                const op = FILE_TOOL_OPERATIONS[toolName];
                if (op && input.file_path) {
                  fileOperations.push({
                    path: input.file_path,
                    operation: op,
                    timestamp: entry.timestamp,
                    toolName,
                  });
                }
                if (toolName === "Bash" && input.command) {
                  // Bash commands that write files
                  fileOperations.push({
                    path: String(input.command).slice(0, 100),
                    operation: "bash",
                    timestamp: entry.timestamp,
                    toolName: "Bash",
                  });
                }

                // Subagent tracking
                if (toolName === "Agent" && input.prompt) {
                  const agentId = block.id || "unknown";
                  const fullDesc = String(input.description || input.prompt);
                  const meta: SubagentMeta | undefined = subagentMetaMap.get(fullDesc);
                  subagentMap.set(agentId, {
                    agentId,
                    type: meta?.agentType ?? String(input.subagent_type || "general-purpose"),
                    description: (meta?.description ?? fullDesc).slice(0, 200),
                    // Undefined, not 0 — the count materialises only if the
                    // sidechain loop below actually counts something. Current
                    // Claude Code transcripts carry no sidechain assistant
                    // entries at all (see the comment on that loop), so
                    // initialising to 0 manufactured an "authoritative zero"
                    // for every subagent on this backend too, and any consumer
                    // comparing it against Claude Code's own `metaTurnCount`
                    // saw a false disagreement — the identical defect fixed on
                    // the DB path, left standing here (Codex review of #403).
                    messageCount: undefined,
                    toolUsage: {},
                    category: meta?.category,
                    metaTurnCount: meta?.turnCount,
                    metaSourced: meta?.metaSourced ?? false,
                  });
                }
              }
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    return null;
  }

  const cliVersion = mostFrequent(versionCounts) ?? undefined;

  // Enrich subagent entries with runtime metrics from OTEL events
  // (subagent_completed + api_request rollup by prompt.id). Best-effort:
  // when OTEL data is unavailable or the SQLite driver isn't loaded, the
  // subagent entries keep their JSONL-derived skeleton (type, description)
  // without the runtime chips.
  const subagentsArray = Array.from(subagentMap.values());
  await enrichSubagentsFromOtel(summary.sessionId, subagentsArray);

  return {
    ...summary,
    timeline,
    fileOperations,
    subagents: subagentsArray,
    hasThinking: hasThinking || undefined,
    cliVersion,
  };
}

// ─── Aggregate stats (existing, used by stats page) ─────────────────

// `cc1h` is the slice of `cc` written at the 1-hour cache TTL, which bills at
// 2x base input rather than 1.25x.
type TokenBucket = { i: number; o: number; cc: number; cc1h: number; cr: number };

/**
 * Per-model token totals, **split by every dimension that changes the rate**.
 *
 * The above-200k tier is a per-*request* decision: a single turn whose prompt
 * exceeds 200k bills its whole input and output at the higher rates. That
 * decision cannot be made after summing — a session's combined input crosses
 * 200k routinely without any individual turn coming close, and pricing the
 * summed bucket would then bill every ordinary turn long-context. So each turn
 * lands in `base` or `long` as it is read, and the two are priced separately.
 *
 * `fast` is the same argument for `usage.speed === "fast"`, which bills at
 * double (Opus 5 / 4.8: $10/$50 against $5/$25). It is a third bucket rather
 * than a flag because the choice is unrecoverable once turns are summed —
 * exactly like the tier. It needs no long variant: Anthropic's pricing page
 * states fast pricing "applies across the full context window, including
 * requests over 200k input tokens", so there is no tier stacked on top of it.
 */
type ModelBuckets = { base: TokenBucket; long: TokenBucket; fast: TokenBucket };
type PerModelTokens = Map<string, ModelBuckets>;

function emptyBucket(): TokenBucket {
  return { i: 0, o: 0, cc: 0, cc1h: 0, cr: 0 };
}

function bucketIsEmpty(b: TokenBucket): boolean {
  return b.i === 0 && b.o === 0 && b.cc === 0 && b.cc1h === 0 && b.cr === 0;
}

function tiersFor(map: PerModelTokens, model: string | undefined): ModelBuckets {
  const key = model && model !== "<synthetic>" ? model : "unknown";
  let entry = map.get(key);
  if (!entry) {
    entry = { base: emptyBucket(), long: emptyBucket(), fast: emptyBucket() };
    map.set(key, entry);
  }
  return entry;
}

/**
 * Flatten the buckets for the on-disk stats cache, dropping empty ones.
 *
 * The wire shape is `CachedModelBuckets`, whose fields are all optional; an
 * ordinary transcript serializes to `base` alone.
 */
function serializePerModel(map: PerModelTokens): Record<string, CachedModelBuckets> {
  const out: Record<string, CachedModelBuckets> = {};
  for (const [model, tiers] of map) {
    const entry: CachedModelBuckets = {};
    if (!bucketIsEmpty(tiers.base)) entry.base = { ...tiers.base };
    if (!bucketIsEmpty(tiers.long)) entry.long = { ...tiers.long };
    if (!bucketIsEmpty(tiers.fast)) entry.fast = { ...tiers.fast };
    if (entry.base || entry.long || entry.fast) out[model] = entry;
  }
  return out;
}

/** Inverse of {@link serializePerModel}, for the cache-hit path. */
function deserializePerModel(
  raw: Record<string, CachedModelBuckets>
): PerModelTokens {
  const map: PerModelTokens = new Map();
  for (const [model, entry] of Object.entries(raw)) {
    map.set(model, {
      base: entry.base ? { ...entry.base } : emptyBucket(),
      long: entry.long ? { ...entry.long } : emptyBucket(),
      fast: entry.fast ? { ...entry.fast } : emptyBucket(),
    });
  }
  return map;
}

function addInto(dest: TokenBucket, src: TokenBucket): void {
  dest.i += src.i; dest.o += src.o; dest.cc += src.cc;
  dest.cc1h += src.cc1h; dest.cr += src.cr;
}

/**
 * Accumulate ONE assistant turn, choosing its bucket from its own speed and
 * prompt size.
 */
function accumulateTurn(
  map: PerModelTokens,
  model: string | undefined,
  inp: number, out: number, cc: number, cr: number,
  cc1h = 0,
  speed?: string,
): void {
  const tiers = tiersFor(map, model);
  // Fast mode is checked first and wins outright: it is priced across the full
  // context window, so a fast turn has no long-context variant to fall into.
  // Bucket by the size of the whole prompt, not just its uncached part —
  // cached tokens still count toward the >200k boundary, and Claude Code
  // reports them separately, so a cache-heavy long request would otherwise
  // land in the base bucket. Must match `applyPricing`'s `auto` rule exactly:
  // this function's whole job is to pre-decide the tier that function would
  // have inferred, and a disagreement between the two is invisible.
  const bucket =
    speed === "fast"
      ? tiers.fast
      : inp + cr + cc > TIER_BOUNDARY
        ? tiers.long
        : tiers.base;
  addInto(bucket, { i: inp, o: out, cc, cc1h, cr });
}

/** Fold one already-split map into another, preserving the split. */
function mergePerModel(dest: PerModelTokens, src: PerModelTokens): void {
  for (const [model, tiers] of src) {
    const into = tiersFor(dest, model);
    addInto(into.base, tiers.base);
    addInto(into.long, tiers.long);
    addInto(into.fast, tiers.fast);
  }
}

/**
 * Fold in a pre-aggregated, split-less file total.
 *
 * Only reachable for a cache entry written before `perModel` existed. Version
 * 2 of the stats cache discards those wholesale, so in practice this is dead —
 * it stays as the honest degradation for an entry that somehow arrives without
 * a breakdown, and it is the exact behaviour #394 describes as the bug:
 * everything attributed to `unknown` (priced as Sonnet), base tier, and no
 * 1-hour cache-write split.
 */
function accumulateCachedFileTotal(
  map: PerModelTokens,
  model: string | undefined,
  inp: number, out: number, cc: number, cr: number,
): void {
  addInto(tiersFor(map, model).base, { i: inp, o: out, cc, cc1h: 0, cr });
}

async function scanConversationFile(filePath: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  turns: number;
  tools: Record<string, number>;
  errors: number;
  models: Set<string>;
  perModelTokens: PerModelTokens;
}> {
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    tools: {} as Record<string, number>,
    errors: 0,
    models: new Set<string>(),
    perModelTokens: new Map() as PerModelTokens,
  };

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);
        if (entry.type === "user") result.turns++;
        if (entry.type === "assistant" && entry.message) {
          result.turns++;
          const msg = entry.message;
          const model = msg.model;
          if (model && model !== "<synthetic>") result.models.add(model);
          const usage = msg.usage;
          if (usage) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cc  = usage.cache_creation_input_tokens || 0;
            const cc1h = extractCacheCreate1hTokens(usage) ?? 0;
            const cr  = usage.cache_read_input_tokens || 0;
            result.inputTokens += inp;
            result.outputTokens += out;
            result.cacheCreateTokens += cc;
            result.cacheReadTokens += cr;
            accumulateTurn(
              result.perModelTokens, model, inp, out, cc, cr, cc1h,
              (usage as { speed?: string }).speed,
            );
          }
          if (entry.isApiErrorMessage) result.errors++;
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                result.tools[block.name] = (result.tools[block.name] || 0) + 1;
              }
            }
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // file error
  }

  return result;
}

/**
 * Sum per-model token buckets into a dollar cost.
 *
 * Delegates to `applyPricing` rather than re-implementing the formula, which
 * this (and its former duplicate in `scanSessionFile`) used to do by hand. That
 * hand-rolled copy silently skipped every refinement the shared function
 * gained — the >200k long-context tier, and now the 1-hour cache-write rate —
 * so the session list and the usage dashboard priced the same tokens
 * differently.
 */
function computeCostFromPerModel(perModelTokens: PerModelTokens): number {
  let cost = 0;
  for (const [model, tiers] of perModelTokens) {
    const id = model === "unknown" ? "" : model;
    const pricing = getModelPricing(id);
    // Each bucket is a sum of many requests, so the tier is passed explicitly
    // rather than inferred from the summed prompt size.
    cost += applyPricing(pricing, toCounts(tiers.base), "base");
    cost += applyPricing(pricing, toCounts(tiers.long), "long");
    // Fast turns resolve against a different rate table entirely, hence the
    // second lookup. `"base"` because fast pricing is flat across the window.
    if (!bucketIsEmpty(tiers.fast)) {
      cost += applyPricing(getModelPricing(id, "fast"), toCounts(tiers.fast), "base");
    }
  }
  return cost;
}

function toCounts(bucket: TokenBucket): TokenCounts {
  return {
    inputTokens: bucket.i,
    outputTokens: bucket.o,
    cacheCreateTokens: bucket.cc,
    cacheCreate1hTokens: bucket.cc1h,
    cacheReadTokens: bucket.cr,
  };
}

export async function scanClaudeConversations(
  projectPath: string
): Promise<ClaudeUsageStats | undefined> {
  const encoded = encodePath(projectPath);
  const projectDir = path.join(os.homedir(), ".claude", "projects", encoded);

  let jsonlFiles: string[];
  try {
    const entries = await fs.readdir(projectDir);
    jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
  } catch {
    return undefined;
  }

  if (jsonlFiles.length === 0) return undefined;

  const stats: ClaudeUsageStats = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, toolUsage: {}, errorCount: 0,
    modelsUsed: [], costEstimate: 0, conversationCount: jsonlFiles.length,
  };

  const allModels = new Set<string>();
  const perModel: PerModelTokens = new Map();
  for (let i = 0; i < jsonlFiles.length; i += 5) {
    const batch = jsonlFiles.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((f) => scanConversationFile(path.join(projectDir, f)))
    );
    for (const r of results) {
      stats.inputTokens += r.inputTokens;
      stats.outputTokens += r.outputTokens;
      stats.cacheCreateTokens += r.cacheCreateTokens;
      stats.cacheReadTokens += r.cacheReadTokens;
      stats.totalTurns += r.turns;
      stats.errorCount += r.errors;
      for (const model of r.models) allModels.add(model);
      for (const [tool, count] of Object.entries(r.tools)) {
        stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count;
      }
      mergePerModel(perModel, r.perModelTokens);
    }
  }

  await loadPricing();
  stats.totalTokens = stats.inputTokens + stats.outputTokens;
  stats.modelsUsed = Array.from(allModels);
  stats.costEstimate = computeCostFromPerModel(perModel);
  return stats;
}

export async function scanAllClaudeConversations(): Promise<ClaudeUsageStats> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  return scanConversationDirs(projectsDir);
}

/**
 * Scan Claude conversations scoped to specific project paths only.
 * Prevents inflating stats with unrelated repos outside devRoot.
 */
export async function scanClaudeConversationsForProjects(
  projectPaths: string[]
): Promise<ClaudeUsageStats> {
  // Sweep every readable Claude home, not just the primary tree: a
  // UNC-scanned WSL project's sessions live under the Linux-encoded dir in
  // its distro's home. Callers pass paths already expanded with their mapped
  // forms (getClaudeUsage), so the encoded allow-set covers both encodings.
  const { readConfig } = await import("../config");
  const { getReadableClaudeHomes } = await import("../claudeHome");
  const config = await readConfig();
  const homes = await getReadableClaudeHomes(config);
  const allowedDirs = new Set(projectPaths.map((p) => encodePath(p)));

  const parts: ClaudeUsageStats[] = [];
  for (const home of homes) {
    parts.push(await scanConversationDirs(path.join(home, "projects"), allowedDirs));
  }
  return mergeClaudeUsageStats(parts);
}

/** Additive merge of per-home aggregates (sums, tool-usage key sums, model union). */
function mergeClaudeUsageStats(parts: ClaudeUsageStats[]): ClaudeUsageStats {
  const out: ClaudeUsageStats = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, toolUsage: {}, errorCount: 0,
    modelsUsed: [], costEstimate: 0, conversationCount: 0,
  };
  const models = new Set<string>();
  for (const p of parts) {
    out.totalTokens += p.totalTokens;
    out.inputTokens += p.inputTokens;
    out.outputTokens += p.outputTokens;
    out.cacheCreateTokens += p.cacheCreateTokens;
    out.cacheReadTokens += p.cacheReadTokens;
    out.totalTurns += p.totalTurns;
    out.errorCount += p.errorCount;
    out.costEstimate += p.costEstimate;
    out.conversationCount += p.conversationCount;
    for (const [tool, n] of Object.entries(p.toolUsage)) {
      out.toolUsage[tool] = (out.toolUsage[tool] ?? 0) + n;
    }
    for (const m of p.modelsUsed) models.add(m);
  }
  out.modelsUsed = [...models];
  return out;
}

async function scanConversationDirs(
  projectsDir: string,
  allowedDirs?: Set<string>
): Promise<ClaudeUsageStats> {
  const aggregate: ClaudeUsageStats = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, toolUsage: {}, errorCount: 0,
    modelsUsed: [], costEstimate: 0, conversationCount: 0,
  };

  let dirs: string[];
  try { dirs = await fs.readdir(projectsDir); } catch { return aggregate; }

  // Load persistent disk cache for incremental parsing
  const diskCache = await readDiskCache();
  const updatedCache = new Map<string, CachedFileStats>();
  let cacheChanged = false;

  const allModels = new Set<string>();
  // Accumulate per-model tokens for accurate cost calculation.
  // Cache hits lack per-model breakdown → bucketed as "unknown" (sonnet fallback).
  const aggregatePerModel: PerModelTokens = new Map();

  for (const dir of dirs) {
    if (allowedDirs && !allowedDirs.has(dir)) continue;

    const dirPath = path.join(projectsDir, dir);
    try {
      const dirStat = await fs.stat(dirPath);
      if (!dirStat.isDirectory()) continue;
      const entries = await fs.readdir(dirPath);
      const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        const fstat = await fs.stat(filePath);
        const cached = diskCache.get(filePath);

        let fileStats: CachedFileStats;
        let fileCostPerModel: PerModelTokens | null = null;

        if (isCacheHit(cached, fstat.mtimeMs, fstat.size)) {
          fileStats = cached!;
          // Rehydrate the per-model/per-rate split the last full parse stored
          // (#394). Without it the recompute below loses the model, the
          // long-context tier and the 1-hour cache TTL all at once, so the
          // displayed cost dropped on the second scan and stayed low.
          fileCostPerModel = fileStats.perModel
            ? deserializePerModel(fileStats.perModel)
            : null;
        } else {
          const result = await scanConversationFile(filePath);
          fileStats = {
            filePath,
            mtime: fstat.mtimeMs,
            size: fstat.size,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheCreateTokens: result.cacheCreateTokens,
            cacheReadTokens: result.cacheReadTokens,
            turns: result.turns,
            tools: result.tools,
            errors: result.errors,
            models: Array.from(result.models),
            perModel: serializePerModel(result.perModelTokens),
          };
          fileCostPerModel = result.perModelTokens;
          cacheChanged = true;
        }

        updatedCache.set(filePath, fileStats);

        // Aggregate token counts for display
        aggregate.inputTokens += fileStats.inputTokens;
        aggregate.outputTokens += fileStats.outputTokens;
        aggregate.cacheCreateTokens += fileStats.cacheCreateTokens;
        aggregate.cacheReadTokens += fileStats.cacheReadTokens;
        aggregate.totalTurns += fileStats.turns;
        aggregate.errorCount += fileStats.errors;
        aggregate.conversationCount++;
        for (const model of fileStats.models) allModels.add(model);
        for (const [tool, count] of Object.entries(fileStats.tools)) {
          aggregate.toolUsage[tool] = (aggregate.toolUsage[tool] || 0) + count;
        }

        if (fileCostPerModel && fileCostPerModel.size > 0) {
          mergePerModel(aggregatePerModel, fileCostPerModel);
        } else {
          // Cache hit — no per-model breakdown; attribute to "unknown" (sonnet fallback pricing).
          accumulateCachedFileTotal(aggregatePerModel, "unknown",
            fileStats.inputTokens, fileStats.outputTokens,
            fileStats.cacheCreateTokens, fileStats.cacheReadTokens,
          );
        }
      }
    } catch { /* skip */ }
  }

  if (cacheChanged) {
    await writeDiskCache(updatedCache);
  }

  await loadPricing();
  aggregate.totalTokens = aggregate.inputTokens + aggregate.outputTokens;
  aggregate.modelsUsed = Array.from(allModels);
  aggregate.costEstimate = computeCostFromPerModel(aggregatePerModel);
  return aggregate;
}
