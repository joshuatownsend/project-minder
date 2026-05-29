import type { ToolCall, UsageTurn } from "./types";
import { getModelPricing } from "./costCalculator";

// ── Model context windows ─────────────────────────────────────────────────────
//
// Used to derive context-fill % per turn (input_tokens / window). The 1M-
// context Sonnet 4.x SKU is opted into via the `[1m]` suffix on the model id
// (Claude Code surfaces it in JSONL exactly that way); without the suffix,
// the same model runs in the standard 200K window. Unknown models fall back
// to 200K with a one-time stderr warn so degradation is visible — silent 0%
// fill would mask real compaction-loop sessions during the rollout window
// while we observe new model ids.

const DEFAULT_CONTEXT_WINDOW = 200_000;
const ONE_MILLION_CONTEXT = 1_000_000;

/** Known context windows, keyed by lowercased model substring. Match order matters. */
const KNOWN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  // Newer Anthropic line — 200K standard
  [/^claude-(opus|sonnet|haiku)-/i, 200_000],
  // Pre-4 Claude families
  [/^claude-3/i, 200_000],
  [/^claude-2/i, 100_000],
];

const warnedModels = new Set<string>();

/**
 * Look up a model's context window in tokens. Honors the `[1m]` suffix that
 * Claude Code uses to flag the 1M-context Sonnet 4.x SKU. Unknown models log
 * a one-time warn and fall back to 200K.
 */
export function getModelContextWindow(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  // `[1m]` suffix → 1M-context variant of any base model.
  if (/\[1m\]/i.test(model)) return ONE_MILLION_CONTEXT;

  for (const [pattern, window] of KNOWN_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return window;
  }

  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    // eslint-disable-next-line no-console
    console.warn(
      `[sessionQuality] unknown model "${model}"; using default context window ${DEFAULT_CONTEXT_WINDOW}`
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Test-only: clear the one-time-warn dedup so repeated runs surface the warn. */
export function _resetWarnedModelsForTesting(): void {
  warnedModels.clear();
}

// ── Cache statistics (#100) ───────────────────────────────────────────────────

export interface CacheStats {
  /** Sum of cache_read tokens across all assistant turns. */
  cacheReadTokens: number;
  /** Sum of cache_creation tokens across all assistant turns. */
  cacheCreateTokens: number;
  /** cache_read / (cache_read + cache_create). null when there's no cache activity. */
  hitRatio: number | null;
  /**
   * Dollar cost of cache rebuild waste: how much the user paid to write
   * cache that never paid off as reads. Positive when create-cost exceeds
   * read-savings. Computed per turn so per-model pricing stays accurate.
   *
   * Formula per turn: cache_create * cacheWriteCost - cache_read * cacheReadCost.
   * Per the Clauditor reference this is "hidden waste" — the build-side
   * spend net of the savings. Negative values mean the cache paid back
   * more than its build cost (good); we still report them so the panel
   * can show "saved" instead of "wasted".
   */
  rebuildWasteUsd: number;
}

export function computeCacheStats(turns: UsageTurn[]): CacheStats {
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let rebuildWasteUsd = 0;

  for (const t of turns) {
    if (t.role !== "assistant") continue;
    cacheReadTokens += t.cacheReadTokens;
    cacheCreateTokens += t.cacheCreateTokens;
    if (t.cacheCreateTokens === 0 && t.cacheReadTokens === 0) continue;

    const pricing = getModelPricing(t.model);
    const buildCost = t.cacheCreateTokens * pricing.cacheWriteCostPerToken;
    const savings = t.cacheReadTokens * pricing.cacheReadCostPerToken;
    rebuildWasteUsd += buildCost - savings;
  }

  const total = cacheReadTokens + cacheCreateTokens;
  const hitRatio = total > 0 ? cacheReadTokens / total : null;

  return {
    cacheReadTokens,
    cacheCreateTokens,
    hitRatio,
    rebuildWasteUsd,
  };
}

// ── Compaction-loop detection (#102) ──────────────────────────────────────────

/**
 * Detect "compaction loops" — consecutive assistant turn pairs where input
 * token count varies by less than 10% AND fill % stays above 75%. Per the
 * Clauditor heuristic: signals Claude is burning tokens cycling on the same
 * context without progress. Three or more such pairs in a row are merged
 * into a single finding spanning the whole run.
 *
 * Findings are reported by the assistant turn indices that anchor the run
 * (first turn of the first pair → second turn of the last pair).
 */
export interface CompactionFinding {
  /** Assistant turn index where the loop run begins. */
  startIndex: number;
  /** Assistant turn index where the loop run ends. */
  endIndex: number;
  /** Number of consecutive qualifying pairs. */
  pairCount: number;
  /** Peak fill ratio observed in the run, in [0, 1]. */
  peakFill: number;
}

const COMPACTION_LOOP_VARIANCE = 0.10;
const COMPACTION_LOOP_FILL_THRESHOLD = 0.75;

/** Compact projection of the assistant turns the compaction-loop scan
 *  cares about. Built once during the bundled fused pass and reused. */
interface AssistantFillRow {
  index: number;
  turn: UsageTurn;
  fill: number;
}

export function detectCompactionLoops(turns: UsageTurn[]): CompactionFinding[] {
  // Per TODO #102's spec: fill = `input_tokens / model_context_window`.
  // `input_tokens` from Claude Code's JSONL is the count of NEW uncached
  // tokens the model read this turn — cache_read / cache_create are
  // separate counters. On a healthy cached session this is intentionally
  // small (< a few %); on a session whose cache keeps invalidating,
  // input_tokens stays large per turn. The 75% threshold therefore
  // fires when the model is processing >150K of fresh content per turn —
  // i.e. cache is broken or absent. Earlier draft summed all three
  // counters; that produced fills >300% on healthy heavily-cached
  // sessions because cached reads can cumulatively exceed the window
  // (rolling cache pattern). Reverted to the spec's semantic.
  const assistantTurns: AssistantFillRow[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant") continue;
    if (t.inputTokens <= 0) continue;
    const window = getModelContextWindow(t.model);
    assistantTurns.push({ index: i, turn: t, fill: t.inputTokens / window });
  }
  return scanCompactionPairs(assistantTurns);
}

/** Pair-window scan over the assistant-fill projection. Pulled out of
 *  detectCompactionLoops so the bundled fused pass can reuse it without
 *  rebuilding the projection. */
function scanCompactionPairs(assistantTurns: AssistantFillRow[]): CompactionFinding[] {
  const findings: CompactionFinding[] = [];
  let runStart = -1;
  let runStartTurnIdx = -1;
  let runPairs = 0;
  let runPeakFill = 0;

  for (let i = 1; i < assistantTurns.length; i++) {
    const prev = assistantTurns[i - 1];
    const curr = assistantTurns[i];

    const variance = Math.abs(curr.turn.inputTokens - prev.turn.inputTokens) / Math.max(prev.turn.inputTokens, 1);
    const minFill = Math.min(prev.fill, curr.fill);
    const isLoopPair = variance < COMPACTION_LOOP_VARIANCE && minFill > COMPACTION_LOOP_FILL_THRESHOLD;

    if (isLoopPair) {
      if (runStart === -1) {
        runStart = prev.index;
        runStartTurnIdx = i - 1;
        runPeakFill = Math.max(prev.fill, curr.fill);
      } else {
        runPeakFill = Math.max(runPeakFill, curr.fill);
      }
      runPairs++;
    } else if (runStart !== -1) {
      // Close out the current run.
      findings.push({
        startIndex: runStart,
        endIndex: assistantTurns[runStartTurnIdx + runPairs].index,
        pairCount: runPairs,
        peakFill: runPeakFill,
      });
      runStart = -1;
      runStartTurnIdx = -1;
      runPairs = 0;
      runPeakFill = 0;
    }
  }

  // Tail flush — the loop ended on a still-open run.
  if (runStart !== -1) {
    findings.push({
      startIndex: runStart,
      endIndex: assistantTurns[runStartTurnIdx + runPairs].index,
      pairCount: runPairs,
      peakFill: runPeakFill,
    });
  }

  return findings;
}

// ── Tool-failure streak detection (#104) ──────────────────────────────────────

/**
 * Scan tool_result-bearing turns for streaks where >50% of results across
 * 5+ consecutive evaluable turns contain error indicators. "Evaluable" =
 * the user turn carries `toolResultText`; turns without tool results are
 * skipped (they don't contribute to the window count). The first 6 turns
 * (any role) are skipped per Clauditor's grace heuristic — early-session
 * experimentation produces noise that isn't a real degradation signal.
 *
 * Error markers: result type `error` (mapped to `isError` on UsageTurn for
 * assistant API errors), or content containing `Error:` / `failed` /
 * `not found` (case-insensitive substring). The latter set matches Claude
 * Code's tool-result conventions and the Clauditor reference.
 */
export interface StreakFinding {
  /** Index of the first evaluable turn in the streak (in `turns[]`). */
  startIndex: number;
  /** Index of the last evaluable turn in the streak. */
  endIndex: number;
  /** Number of evaluable turns in the streak. */
  windowSize: number;
  /** How many of those `windowSize` turns matched an error marker. */
  failureCount: number;
  /** failureCount / windowSize — always >0.5 for emitted findings. */
  failureRate: number;
}

const STREAK_GRACE_TURNS = 6;
const STREAK_WINDOW_MIN = 5;
const STREAK_FAILURE_THRESHOLD = 0.50;
const ERROR_MARKER_RE = /(error:|failed|not found)/i;

interface EvaluableTurn {
  index: number;
  failed: boolean;
}

export function detectToolFailureStreaks(turns: UsageTurn[]): StreakFinding[] {
  // Build the evaluable-turn projection. A turn is evaluable when it
  // carries a tool_result (user turn with toolResultText) OR an API error
  // (assistant with isError). Both signal a "tool round-trip" the streak
  // detector cares about; turns without either don't move the window.
  const evaluable: EvaluableTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i < STREAK_GRACE_TURNS) continue;
    const t = turns[i];
    if (t.role === "user" && t.toolResultText) {
      evaluable.push({ index: i, failed: ERROR_MARKER_RE.test(t.toolResultText) });
    } else if (t.role === "assistant" && t.isError) {
      evaluable.push({ index: i, failed: true });
    }
  }
  return scanFailureWindows(evaluable);
}

/** Greedy non-overlapping window scan over the evaluable projection.
 *  Pulled out of detectToolFailureStreaks so the bundled fused pass can
 *  reuse it without rebuilding the projection. */
function scanFailureWindows(evaluable: EvaluableTurn[]): StreakFinding[] {
  if (evaluable.length < STREAK_WINDOW_MIN) return [];

  // Extend a window as long as the failure rate stays above 50%. When it
  // can no longer be extended, emit if it reached the minimum size, then
  // jump past the window so the next run starts fresh. This avoids
  // reporting overlapping windows for the same failure cluster.
  const findings: StreakFinding[] = [];
  let i = 0;
  while (i <= evaluable.length - STREAK_WINDOW_MIN) {
    let failures = 0;
    for (let j = 0; j < STREAK_WINDOW_MIN; j++) {
      if (evaluable[i + j].failed) failures++;
    }
    if (failures / STREAK_WINDOW_MIN > STREAK_FAILURE_THRESHOLD) {
      let end = i + STREAK_WINDOW_MIN - 1;
      while (end + 1 < evaluable.length) {
        const nextFailures = failures + (evaluable[end + 1].failed ? 1 : 0);
        const nextSize = end - i + 2;
        if (nextFailures / nextSize > STREAK_FAILURE_THRESHOLD) {
          failures = nextFailures;
          end++;
        } else {
          break;
        }
      }
      const windowSize = end - i + 1;
      findings.push({
        startIndex: evaluable[i].index,
        endIndex: evaluable[end].index,
        windowSize,
        failureCount: failures,
        failureRate: failures / windowSize,
      });
      i = end + 1;
    } else {
      i++;
    }
  }

  return findings;
}

// ── Stuck-loop detection (#178: cc-blackbox-inspired) ────────────────────────

/**
 * Detect "stuck loops" — runs of 3+ consecutive tool actions that repeat the
 * SAME tool call (identical name + identical arguments) AND produce the SAME
 * result text. A model re-issuing the exact same command and getting the exact
 * same output is the strongest signal it is stuck, distinct from the
 * `oneShotDetector` (edit→test→re-edit retry cycles, where inputs change) and
 * from `detectToolFailureStreaks` (errors vary across turns). Per the
 * cc-blackbox reference, identical-input-and-output repetition is the marker.
 *
 * "Consecutive" is measured over the tool-action projection (assistant turns
 * that issue ≥1 tool call), so interleaved commentary turns without tool calls
 * do not break a run. Requiring the result to match keeps false positives low.
 */
export interface StuckLoopFinding {
  /** Distinct tool name(s) involved in the repeated action, comma-joined. */
  tool: string;
  /** Assistant turn index (in `turns[]`) where the loop run begins. */
  startIndex: number;
  /** Assistant turn index where the loop run ends. */
  endIndex: number;
  /** Number of consecutive identical (call, result) repeats — always ≥3. */
  repeatCount: number;
}

const STUCK_LOOP_MIN_REPEATS = 3;

/** Deterministic stringify with sorted object keys, so argument equality is
 *  order-independent. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Cheap human label (distinct tool names) for an assistant turn's tool calls. */
function toolLabel(calls: ToolCall[]): string {
  return Array.from(new Set(calls.map((c) => c.name))).join(", ");
}

/** Full identity signature (name + order-independent args). Expensive — it
 *  serializes arguments, which can be large (e.g. a Write call's file body) —
 *  so `scanStuckLoops` only builds it for rows whose cheap label+result already
 *  match a neighbour. */
function toolSig(calls: ToolCall[]): string {
  // Each element is `name(args)` — the parens delimit calls, so a plain
  // concatenation is unambiguous and needs no separator. (Previously joined on
  // a literal SOH control char, invisible in source — see PR #183.)
  return calls.map((c) => `${c.name}(${stableStringify(c.arguments ?? {})})`).join("");
}

/** One assistant tool-issuing turn plus the result text that followed it. */
// Mirrors the tool-result preview cap in parser.ts (`extractToolResults`
// slices to 2000 chars). A result at this length is likely truncated, so two
// different long outputs can share a prefix — we don't let those anchor a loop.
const TOOL_RESULT_PREVIEW_CHARS = 2000;

interface ToolActionRow {
  index: number;
  label: string;
  calls: ToolCall[];
  /** Trimmed tool-result preview; `undefined` when no tool_result was observed
   *  for this call — so "no result" never matches "no result". */
  result?: string;
  /** Result hit the preview cap (likely truncated) — can't confidently anchor
   *  a loop since different long outputs may share the captured prefix. */
  resultTruncated?: boolean;
  /** A genuine human prompt preceded this row — barriers the run (the model is
   *  not looping on its own if the user asked for the rerun). */
  barrier?: boolean;
}

interface ProjBuildState {
  pending: number; // index of the row awaiting its tool result, or -1
  pendingBarrier: boolean; // a human prompt is queued to barrier the next row
}

/** Fold one turn into the tool-action projection. Shared by `detectStuckLoops`
 *  and the fused `computeSessionQuality` pass (called once per turn — no extra
 *  pass) so the barrier/truncation-aware logic can't diverge between them. */
function projectToolAction(
  proj: ToolActionRow[],
  state: ProjBuildState,
  t: UsageTurn,
  i: number
): void {
  if (t.role === "assistant" && t.toolCalls.length > 0) {
    proj.push({
      index: i,
      label: toolLabel(t.toolCalls),
      calls: t.toolCalls,
      barrier: state.pendingBarrier,
    });
    state.pending = proj.length - 1;
    state.pendingBarrier = false;
  } else if (t.role === "user") {
    if (t.toolResultText !== undefined) {
      // A tool result (even whitespace-only, which trims to "") — attach it.
      if (state.pending !== -1) {
        proj[state.pending].result = t.toolResultText.trim();
        proj[state.pending].resultTruncated = t.toolResultText.length >= TOOL_RESULT_PREVIEW_CHARS;
        state.pending = -1;
      }
    } else if (t.userMessageText) {
      // A real human prompt (no tool_result): the next tool run starts fresh —
      // user-requested reruns are not the model spinning on its own.
      state.pendingBarrier = true;
    }
  }
}

export function detectStuckLoops(turns: UsageTurn[]): StuckLoopFinding[] {
  const proj: ToolActionRow[] = [];
  const state: ProjBuildState = { pending: -1, pendingBarrier: false };
  for (let i = 0; i < turns.length; i++) projectToolAction(proj, state, turns[i], i);
  return scanStuckLoops(proj);
}

/** Run-length scan over the tool-action projection. Pulled out so the bundled
 *  fused pass can reuse it without rebuilding the projection.
 *
 *  Signatures are computed lazily and memoized: the expensive `toolSig` (which
 *  serializes tool arguments) only runs when two adjacent rows already agree on
 *  the cheap `label` and `result`. Label equality is a necessary precondition
 *  for signature equality, so this never misses a real loop — it just avoids
 *  serializing arguments for the turns that never participate in one. */
function scanStuckLoops(proj: ToolActionRow[]): StuckLoopFinding[] {
  const findings: StuckLoopFinding[] = [];
  const sigMemo: (string | undefined)[] = new Array(proj.length);
  const sigOf = (i: number): string => (sigMemo[i] ??= toolSig(proj[i].calls));
  // A result can only confirm "identical output" when it was actually observed
  // and wasn't truncated at the preview cap.
  const comparable = (r: ToolActionRow): boolean =>
    r.result !== undefined && !r.resultTruncated;

  let runStart = 0;
  for (let i = 1; i <= proj.length; i++) {
    const sameAsPrev =
      i < proj.length &&
      !proj[i].barrier &&
      proj[i].label === proj[i - 1].label &&
      comparable(proj[i]) &&
      comparable(proj[i - 1]) &&
      proj[i].result === proj[i - 1].result &&
      sigOf(i) === sigOf(i - 1);
    if (sameAsPrev) continue;
    const runLen = i - runStart;
    if (runLen >= STUCK_LOOP_MIN_REPEATS) {
      findings.push({
        tool: proj[runStart].label,
        startIndex: proj[runStart].index,
        endIndex: proj[i - 1].index,
        repeatCount: runLen,
      });
    }
    runStart = i;
  }
  return findings;
}

// ── Bundled compute (used by ingest + diagnosis) ─────────────────────────────

export interface SessionQualitySummary {
  cache: CacheStats;
  compactionLoops: CompactionFinding[];
  toolFailureStreaks: StreakFinding[];
  /** Runs of 3+ identical repeated tool calls (same input AND output). */
  stuckLoops: StuckLoopFinding[];
  /** Peak input_tokens / context_window across all assistant turns, in [0, 1]. */
  maxContextFill: number;
}

/**
 * Run all three detectors plus the cheap max-fill scan. Used by ingest to
 * persist boolean flags + cache_hit_ratio + max_context_fill, and by the
 * diagnosis route as the foundation for the full DiagnosisReport.
 *
 * Implementation: one pass over `turns[]` builds (a) cache totals,
 * (b) per-assistant-turn fill projection, (c) tool-failure evaluable
 * projection, (d) max-fill, all simultaneously. The two window-scan
 * post-passes (compaction-pair scan, failure-rate scan) then run on the
 * smaller projections — they are the work, not the redundancy.
 *
 * The per-detector exports (`computeCacheStats`, `detectCompactionLoops`,
 * `detectToolFailureStreaks`) remain available for callers that only
 * need one signal; they delegate to the same private window-scan helpers
 * so behavior stays byte-equal to the bundled path. Pinned by the
 * "all 4 detectors firing in one mixed session" golden vector test.
 */
export function computeSessionQuality(turns: UsageTurn[]): SessionQualitySummary {
  let maxContextFill = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let rebuildWasteUsd = 0;
  const assistantProj: AssistantFillRow[] = [];
  const evaluable: EvaluableTurn[] = [];
  const toolActionProj: ToolActionRow[] = [];
  const stuckState: ProjBuildState = { pending: -1, pendingBarrier: false };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];

    if (t.role === "assistant") {
      cacheReadTokens += t.cacheReadTokens;
      cacheCreateTokens += t.cacheCreateTokens;
      if (t.cacheCreateTokens > 0 || t.cacheReadTokens > 0) {
        const pricing = getModelPricing(t.model);
        rebuildWasteUsd +=
          t.cacheCreateTokens * pricing.cacheWriteCostPerToken -
          t.cacheReadTokens * pricing.cacheReadCostPerToken;
      }
      if (t.inputTokens > 0) {
        const window = getModelContextWindow(t.model);
        const fill = t.inputTokens / window;
        if (fill > maxContextFill) maxContextFill = fill;
        assistantProj.push({ index: i, turn: t, fill });
      }
    }

    // Tool-failure projection: skip the grace period, then collect any
    // turn that carries a tool-result signal.
    if (i >= STREAK_GRACE_TURNS) {
      if (t.role === "user" && t.toolResultText) {
        evaluable.push({ index: i, failed: ERROR_MARKER_RE.test(t.toolResultText) });
      } else if (t.role === "assistant" && t.isError) {
        evaluable.push({ index: i, failed: true });
      }
    }

    // Stuck-loop projection — same per-turn fold the standalone path uses.
    projectToolAction(toolActionProj, stuckState, t, i);
  }

  const cacheTotal = cacheReadTokens + cacheCreateTokens;
  const cache: CacheStats = {
    cacheReadTokens,
    cacheCreateTokens,
    hitRatio: cacheTotal > 0 ? cacheReadTokens / cacheTotal : null,
    rebuildWasteUsd,
  };

  return {
    cache,
    compactionLoops: scanCompactionPairs(assistantProj),
    toolFailureStreaks: scanFailureWindows(evaluable),
    stuckLoops: scanStuckLoops(toolActionProj),
    maxContextFill,
  };
}

// ── Per-turn context fill (used by ingest write + diagnosis) ─────────────────

/**
 * Fill ratio for a single assistant turn, or null for user/zero-input turns.
 * Exposed so DB ingest can persist `turns.context_fill` and the diagnosis
 * panel can render a per-turn fill series without recomputing the lookup.
 */
export function turnContextFill(turn: UsageTurn): number | null {
  if (turn.role !== "assistant" || turn.inputTokens <= 0) return null;
  return turn.inputTokens / getModelContextWindow(turn.model);
}

