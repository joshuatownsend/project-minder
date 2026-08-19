// Per-turn context attribution — what actually filled the context window,
// broken down by source, across the life of one session.
//
// **How this differs from `contextOverhead.ts`.** That module answers a
// *portfolio, pre-flight* question: "before I type anything, how much
// context do my MCP servers / skills / memory files consume?" It is a
// static estimate from file sizes, computed once, identical for every
// session. This module answers a *per-session, retrospective* question:
// "on turn 47, what was in the window, and where did the 90k go?" The two
// are complementary — the static baseline is the floor this series sits on
// top of, and neither can be derived from the other.
//
// **What is measured vs estimated.** Per-turn token TOTALS are ground
// truth: the API reports `input_tokens`, `cache_read_input_tokens`,
// `cache_creation_input_tokens`, and `output_tokens` on every assistant
// turn. The BREAKDOWN is not — nothing in the JSONL says "8k of this turn
// was CLAUDE.md". So attribution is estimated from the character counts of
// the content blocks we can actually see, via the same `BYTES_PER_TOKEN`
// heuristic the rest of the codebase uses.
//
// That gap is surfaced rather than hidden. Each turn reports both the
// attributed total and the measured total, and the difference lands in
// `unattributedTokens` — the system prompt, tool *definitions*, CLAUDE.md,
// and skill bodies all live there, because they are injected by the
// harness and never appear in the transcript. A chart that silently
// normalized these to 100% would look more polished and tell you less.
//
// Categories deliberately describe what the transcript SHOWS. Adapting
// claude-devtools' 7-category split to Minder's data: its "CLAUDE.md",
// "skills", and "team overhead" buckets are not per-turn observable here,
// so they are not invented — they fall into `unattributed`, which
// `contextOverhead.ts` already estimates statically.

import { bytesToTokens, DEFAULT_CONTEXT_WINDOW_TOKENS } from "./tokenEstimate";

/**
 * UTF-8 byte length, isomorphic.
 *
 * Deliberately NOT `Buffer.byteLength`: this module's constants and types
 * are imported by `ContextAttributionPanel`, a `"use client"` component,
 * which pulls the whole module into the browser bundle. `Buffer` is a
 * bare global rather than an import, so it would not fail the build — it
 * would simply be `undefined` at runtime if anything ever called this
 * path client-side, which is the kind of latent break that surfaces long
 * after the change that caused it. `TextEncoder` exists in both runtimes.
 *
 * A single shared encoder avoids allocating one per call; `encode` on a
 * shared instance is safe because it is stateless.
 */
const UTF8 = new TextEncoder();
function utf8Bytes(s: string): number {
  return UTF8.encode(s).length;
}

/** Attributable sources, in the stacking order the chart should use. */
export const CONTEXT_CATEGORIES = [
  "userText",
  "attachedContext",
  "assistantText",
  "thinking",
  "toolInput",
  "toolOutput",
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** Human-facing labels; kept beside the union so they cannot drift. */
export const CONTEXT_CATEGORY_LABELS: Record<ContextCategory, string> = {
  userText: "Your prompts",
  attachedContext: "Attached context",
  assistantText: "Claude's replies",
  thinking: "Extended thinking",
  toolInput: "Tool inputs",
  toolOutput: "Tool output",
};

export type CategoryTokens = Record<ContextCategory, number>;

export interface TurnAttribution {
  turnIndex: number;
  ts: string | null;
  role: "user" | "assistant";
  /** Estimated tokens this turn ADDED to the window, by source. */
  added: CategoryTokens;
  /** Sum of `added`. */
  addedTotal: number;
  /**
   * `input_tokens + cache_read + cache_creation` as reported by the API on
   * assistant turns — the true size of the window at this point. Null on
   * user turns, which carry no usage block.
   */
  measuredContextTokens: number | null;
  /**
   * True when this turn immediately follows a compaction boundary, i.e.
   * the window was discarded and rebuilt just before it.
   */
  afterCompaction: boolean;
}

export interface AttributionSegment {
  /** 0 for the pre-first-compaction stretch, then 1, 2, … */
  index: number;
  startTurn: number;
  endTurn: number;
  /** Cumulative attributed tokens by category across the segment. */
  totals: CategoryTokens;
  /** Sum of `totals`. */
  attributedTotal: number;
  /**
   * Largest `measuredContextTokens` seen in the segment — how full the
   * window actually got before it was compacted (or the session ended).
   */
  peakMeasuredTokens: number | null;
  /**
   * `peakMeasured - (attribution as it stood WHEN the peak was measured)`,
   * floored at 0. The harness-injected remainder: system prompt, tool
   * definitions, CLAUDE.md, skill bodies. Null when nothing was measured.
   *
   * **Why not `attributedTotal`.** `peakMeasuredTokens` is
   * `input_tokens + cache` on one assistant turn — the window as it was
   * fed IN, which by construction excludes that turn's own reply,
   * thinking, and tool calls, and every turn after it. Subtracting the
   * whole-segment total compares two different moments and always
   * understates the remainder by at least the final response; a large
   * response could floor it to zero and hide the harness overhead
   * entirely. So the cumulative total is snapshotted at the peak turn,
   * before that turn's own contribution is added.
   *
   * Floored because the estimate is a lower bound and a negative would
   * render as "saved tokens".
   */
  unattributedTokens: number | null;
  /**
   * Attributed tokens as they stood at the peak measurement — the left
   * side of the subtraction above. Exposed so the UI can show what the
   * remainder was actually computed against rather than implying it was
   * the segment total.
   */
  attributedAtPeak: number | null;
}

export interface ContextAttributionReport {
  sessionId: string;
  turns: TurnAttribution[];
  /** One entry per compaction-delimited stretch; always at least one. */
  segments: AttributionSegment[];
  /** Cumulative attributed tokens by category over the whole session. */
  totals: CategoryTokens;
  attributedTotal: number;
  /** Peak measured window fill across the whole session. */
  peakMeasuredTokens: number | null;
  /** `peakMeasuredTokens` as a share of the context window, 0–100. */
  peakContextPercent: number;
  contextWindowTokens: number;
  /** Number of compaction boundaries detected. */
  compactionCount: number;
  /**
   * The single category contributing the most tokens, or null when the
   * session attributed nothing. Drives the headline "tool output was 71%
   * of your context" line.
   */
  dominantCategory: ContextCategory | null;
  dominantShare: number;
}

export function emptyCategoryTokens(): CategoryTokens {
  return {
    userText: 0,
    attachedContext: 0,
    assistantText: 0,
    thinking: 0,
    toolInput: 0,
    toolOutput: 0,
  };
}

function addInto(target: CategoryTokens, source: CategoryTokens): void {
  for (const c of CONTEXT_CATEGORIES) target[c] += source[c];
}

function sum(t: CategoryTokens): number {
  let n = 0;
  for (const c of CONTEXT_CATEGORIES) n += t[c];
  return n;
}

/**
 * A raw JSONL entry, narrowed to the fields attribution reads. Kept
 * structural (rather than importing a session type) so this module stays
 * pure and testable without the parser or the DB.
 */
export interface AttributionEntry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  subtype?: string;
  /** Shape 3 — top-level field on some CLI versions. */
  compactSummary?: string;
  /** Shape 4 — older versions embed the marker in system-message text. */
  content?: unknown;
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Hook- and harness-injected user turns start with `<` (e.g.
 * `<system-reminder>`, `<command-message>`) or are `@`-mention file
 * expansions. They are user-role but not user-authored, and lumping them
 * into "your prompts" makes the chart read as though you typed 40k
 * characters. They get their own category instead.
 */
function isAttachedContext(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("@");
}

/**
 * Detect a compaction boundary. Claude Code marks these differently
 * across CLI versions, so all three known shapes are accepted rather than
 * pinning one: an explicit `compact_boundary` subtype, the
 * `isCompactSummary` flag, and a system entry whose text names it.
 */
function isCompactionBoundary(e: AttributionEntry): boolean {
  // Shape 1 — system + compact_boundary subtype.
  if (e.subtype === "compact_boundary") return true;
  // Shape 2 — dedicated compact_summary entry type.
  if (e.type === "compact_summary") return true;
  // Shape 3 — top-level compactSummary field.
  if (typeof e.compactSummary === "string" && e.compactSummary) return true;
  // Minder's own flag, set by some parse paths.
  if (e.isCompactSummary === true) return true;
  // Shape 4 — older versions embed the marker in a system message's text.
  if (e.type === "system" && typeof e.content === "string") {
    return (
      e.content.includes("[compact summary]") || e.content.includes("compact_boundary")
    );
  }
  return false;
}

function textOf(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * Build the attribution report for one session from its raw JSONL entries.
 *
 * Sidechain (subagent) entries are excluded: their tokens are billed and
 * do appear in usage totals, but they occupy a SEPARATE context window
 * from the parent session. Folding them in would inflate the parent's
 * apparent fill with tokens that were never in the parent's window — the
 * exact kind of quietly-wrong number this module exists to avoid.
 */
export function attributeContext(
  sessionId: string,
  entries: AttributionEntry[],
  contextWindowTokens: number = DEFAULT_CONTEXT_WINDOW_TOKENS
): ContextAttributionReport {
  const turns: TurnAttribution[] = [];
  const segments: AttributionSegment[] = [];
  // Claude Code can re-log an assistant message on a retry or a
  // resumed-session re-emit. The canonical parser guards this by
  // `message.id` (falling back to `requestId`); a raw-entry loop that
  // skips the guard counts the same reply, thinking, and tool inputs
  // twice, inflating both turn counts and every category total in
  // exactly the sessions most worth inspecting. Only ids actually
  // present are guarded, so genuinely distinct turns are all kept.
  const seenMessageIds = new Set<string>();
  /**
   * #453: the guard above is right about tokens and was wrong about content.
   * Claude Code writes one JSONL line per content block, so a repeat id is
   * usually the same message CONTINUING, and dropping the line discarded its
   * thinking, prose and tool inputs — the very bytes this report exists to
   * account for. Every dropped block landed in `unattributedTokens`, which read
   * as "we cannot explain this window" when in fact we had thrown it away.
   *
   * Merged into the turn the id already owns, with dedupe moved to block level
   * so the genuine re-log (which repeats its `tool_use_id` and its text) still
   * cannot double-count.
   */
  const openAssistant = new Map<
    string,
    { pos: number; segmentIndex: number; toolUseIds: Set<string>; blockKeys: Set<string> }
  >();

  let segmentTotals = emptyCategoryTokens();
  let segmentStart = 0;
  let segmentPeak: number | null = null;
  /**
   * Which turn measured `segmentPeak` — not the byte total at that instant.
   *
   * `attributedAtPeak` is derived from this at segment close instead of being
   * snapshotted live, because a detached continuation can merge bytes into an
   * EARLIER turn after a later turn has already set the peak. Those bytes were
   * part of the window fed to the peak turn — they belong to a turn that
   * preceded it — so a live snapshot omits them and inflates
   * `unattributedTokens` by exactly that amount. Deriving from turn order is
   * immune to when the line carrying them happened to arrive. (Codex, PR #468.)
   *
   * Safe to defer: a continuation is only merged while its segment is still the
   * open one, so every turn in a closed segment is final. Same set of turns the
   * live snapshot covered — `[segmentStart, peakTurn)` — just totalled later.
   */
  let segmentPeakTurn: number | null = null;
  let pendingCompaction = false;
  let turnIndex = 0;

  const closeSegment = (endTurn: number) => {
    const attributedTotal = sum(segmentTotals);
    let atPeak: number | null = null;
    if (segmentPeakTurn !== null) {
      atPeak = 0;
      // Every turn of this segment BEFORE the peak turn; the peak turn's own
      // reply, thinking and tool calls are output, not part of the input window
      // that produced its measurement.
      for (let i = segmentStart; i < segmentPeakTurn; i++) {
        atPeak += turns[i]?.addedTotal ?? 0;
      }
    }
    segments.push({
      index: segments.length,
      startTurn: segmentStart,
      endTurn,
      totals: segmentTotals,
      attributedTotal,
      peakMeasuredTokens: segmentPeak,
      attributedAtPeak: atPeak,
      unattributedTokens:
        segmentPeak === null || atPeak === null
          ? null
          : Math.max(0, segmentPeak - atPeak),
    });
    segmentTotals = emptyCategoryTokens();
    segmentPeak = null;
    segmentPeakTurn = null;
    segmentStart = endTurn + 1;
  };

  /**
   * Walk one entry's `content` into `added`.
   *
   * Shared by a message's first line and its continuation lines so the two
   * cannot drift. `guards`, when present, drops blocks already counted for this
   * message — the re-log case the `message.id` check used to cover wholesale.
   */
  const accumulate = (
    content: unknown,
    role: "user" | "assistant",
    added: CategoryTokens,
    guards: { toolUseIds: Set<string>; blockKeys: Set<string> } | null
  ): void => {
    const bytes = (s: string) => bytesToTokens(utf8Bytes(s));
    if (typeof content === "string") {
      // Guarded like the block branch below. Claude Code's assistant entries are
      // usually a block array, but the plain-string shape is supported and does
      // occur — and a genuine re-log of one would otherwise be added to the turn
      // a second time, inflating `assistantText`, `attributedTotal` and peak
      // attribution, while the array-shaped path stayed correctly deduped.
      // Before continuations were merged at all the repeat line was dropped
      // wholesale, so this is a gap the merge opened rather than a pre-existing
      // one. (Codex, PR #468.)
      if (guards) {
        if (guards.blockKeys.has(`s:${content}`)) return;
        guards.blockKeys.add(`s:${content}`);
      }
      const bucket: ContextCategory = isAttachedContext(content)
        ? "attachedContext"
        : role === "user"
          ? "userText"
          : "assistantText";
      added[bucket] += bytes(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const raw of content as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      switch (raw.type) {
        case "text": {
          const t = textOf(raw);
          if (!t) break;
          if (guards) {
            if (guards.blockKeys.has(`t:${t}`)) break;
            guards.blockKeys.add(`t:${t}`);
          }
          if (role === "assistant") added.assistantText += bytes(t);
          else if (isAttachedContext(t)) added.attachedContext += bytes(t);
          else added.userText += bytes(t);
          break;
        }
        case "thinking": {
          if (typeof raw.thinking !== "string") break;
          if (guards) {
            if (guards.blockKeys.has(`k:${raw.thinking}`)) break;
            guards.blockKeys.add(`k:${raw.thinking}`);
          }
          added.thinking += bytes(raw.thinking);
          break;
        }
        case "tool_use": {
          if (guards && typeof raw.id === "string") {
            if (guards.toolUseIds.has(raw.id)) break;
            guards.toolUseIds.add(raw.id);
          }
          try {
            added.toolInput += bytes(JSON.stringify(raw.input ?? {}));
          } catch {
            // Circular / unserializable input — skip rather than throw.
            // Under-counting one block is strictly better than failing
            // the whole report.
          }
          break;
        }
        case "tool_result": {
          const rc = raw.content;
          if (typeof rc === "string") added.toolOutput += bytes(rc);
          else if (Array.isArray(rc)) {
            for (const x of rc as Array<Record<string, unknown>>) {
              if (x?.type === "text") added.toolOutput += bytes(textOf(x));
            }
          }
          break;
        }
      }
    }
  };

  for (const e of entries) {
    if (isCompactionBoundary(e)) {
      // Close the current stretch. Cumulative context is meaningless
      // across a boundary — the window is discarded and rebuilt — so the
      // series must restart rather than keep climbing.
      closeSegment(Math.max(segmentStart, turnIndex - 1));
      pendingCompaction = true;
      continue;
    }
    if (e.isMeta) continue;
    if (e.isSidechain) continue; // separate context window — see JSDoc
    if (e.type !== "user" && e.type !== "assistant") continue;

    const role = e.type as "user" | "assistant";
    const messageId = role === "assistant" ? e.message?.id ?? e.requestId : undefined;
    if (messageId && seenMessageIds.has(messageId)) {
      const open = openAssistant.get(messageId);
      const turn = open ? turns[open.pos] : undefined;
      // Straddle guard: a continuation that arrives after a compaction boundary
      // belongs to a segment whose totals are already frozen. Adding to the
      // turn but not its segment would desync the two, so drop it — the same
      // narrow limitation ingest documents, and the old behaviour for every
      // continuation rather than just this rare one.
      if (open && turn && open.segmentIndex === segments.length) {
        const extra = emptyCategoryTokens();
        accumulate(e.message?.content, role, extra, open);
        const extraTotal = sum(extra);
        if (extraTotal > 0) {
          addInto(turn.added, extra);
          turn.addedTotal = sum(turn.added);
          addInto(segmentTotals, extra);
        }
      }
      continue;
    }
    if (messageId) seenMessageIds.add(messageId);

    const added = emptyCategoryTokens();
    const guards = messageId
      ? { pos: turns.length, segmentIndex: segments.length, toolUseIds: new Set<string>(), blockKeys: new Set<string>() }
      : null;
    accumulate(e.message?.content, role, added, guards);
    if (messageId && guards) openAssistant.set(messageId, guards);

    const usage = e.message?.usage;
    const measuredContextTokens =
      role === "assistant" && usage
        ? (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
        : null;
    if (measuredContextTokens !== null) {
      if (segmentPeak === null || measuredContextTokens > segmentPeak) {
        segmentPeak = measuredContextTokens;
        // Record WHICH turn, not the running total. `closeSegment` totals the
        // turns before this one at close time, so bytes a detached continuation
        // folds into an earlier turn later still land on the correct side of
        // the measurement. This turn's own reply, thinking and tool calls stay
        // excluded — they are output, not part of the window that produced
        // `measuredContextTokens`.
        segmentPeakTurn = turnIndex;
      }
    }

    addInto(segmentTotals, added);
    turns.push({
      turnIndex,
      ts: e.timestamp ?? null,
      role,
      added,
      addedTotal: sum(added),
      measuredContextTokens,
      afterCompaction: pendingCompaction,
    });
    pendingCompaction = false;
    turnIndex++;
  }

  // Always close the trailing stretch, so `segments` is never empty even
  // for a session with no turns — consumers can index [0] unconditionally.
  closeSegment(Math.max(segmentStart, turnIndex - 1));

  const totals = emptyCategoryTokens();
  for (const s of segments) addInto(totals, s.totals);
  const attributedTotal = sum(totals);

  let peakMeasuredTokens: number | null = null;
  for (const s of segments) {
    if (s.peakMeasuredTokens !== null) {
      peakMeasuredTokens =
        peakMeasuredTokens === null
          ? s.peakMeasuredTokens
          : Math.max(peakMeasuredTokens, s.peakMeasuredTokens);
    }
  }

  let dominantCategory: ContextCategory | null = null;
  let dominantTokens = 0;
  for (const c of CONTEXT_CATEGORIES) {
    if (totals[c] > dominantTokens) {
      dominantTokens = totals[c];
      dominantCategory = c;
    }
  }

  return {
    sessionId,
    turns,
    segments,
    totals,
    attributedTotal,
    peakMeasuredTokens,
    peakContextPercent:
      peakMeasuredTokens === null || contextWindowTokens <= 0
        ? 0
        : Math.min(100, (peakMeasuredTokens / contextWindowTokens) * 100),
    contextWindowTokens,
    // `segments.length - 1` rather than a counter: N boundaries produce
    // N+1 stretches, and the trailing close always runs.
    compactionCount: Math.max(0, segments.length - 1),
    dominantCategory,
    dominantShare: attributedTotal > 0 ? (dominantTokens / attributedTotal) * 100 : 0,
  };
}
