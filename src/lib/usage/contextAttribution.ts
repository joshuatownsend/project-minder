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
   * `peakMeasured - attributedTotal`, floored at 0. This is the harness-
   * injected remainder: system prompt, tool definitions, CLAUDE.md, skill
   * bodies. Null when nothing was measured. Floored because the estimate
   * is a lower bound and a negative would render as "saved tokens".
   */
  unattributedTokens: number | null;
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
  message?: {
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
  if (e.subtype === "compact_boundary") return true;
  if (e.isCompactSummary === true) return true;
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

  let segmentTotals = emptyCategoryTokens();
  let segmentStart = 0;
  let segmentPeak: number | null = null;
  let pendingCompaction = false;
  let turnIndex = 0;

  const closeSegment = (endTurn: number) => {
    const attributedTotal = sum(segmentTotals);
    segments.push({
      index: segments.length,
      startTurn: segmentStart,
      endTurn,
      totals: segmentTotals,
      attributedTotal,
      peakMeasuredTokens: segmentPeak,
      unattributedTokens:
        segmentPeak === null ? null : Math.max(0, segmentPeak - attributedTotal),
    });
    segmentTotals = emptyCategoryTokens();
    segmentPeak = null;
    segmentStart = endTurn + 1;
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
    const added = emptyCategoryTokens();
    const content = e.message?.content;

    if (typeof content === "string") {
      const bucket: ContextCategory = isAttachedContext(content)
        ? "attachedContext"
        : role === "user"
          ? "userText"
          : "assistantText";
      added[bucket] += bytesToTokens(utf8Bytes(content));
    } else if (Array.isArray(content)) {
      for (const raw of content as Array<Record<string, unknown>>) {
        if (!raw || typeof raw !== "object") continue;
        const bytes = (s: string) => bytesToTokens(utf8Bytes(s));
        switch (raw.type) {
          case "text": {
            const t = textOf(raw);
            if (!t) break;
            if (role === "assistant") added.assistantText += bytes(t);
            else if (isAttachedContext(t)) added.attachedContext += bytes(t);
            else added.userText += bytes(t);
            break;
          }
          case "thinking": {
            if (typeof raw.thinking === "string") added.thinking += bytes(raw.thinking);
            break;
          }
          case "tool_use": {
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
    }

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
