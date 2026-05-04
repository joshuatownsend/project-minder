import type { UsageTurn } from "./types";
import {
  computeSessionQuality,
  getModelContextWindow,
  type CacheStats,
  type CompactionFinding,
  type StreakFinding,
} from "./sessionQuality";

// ── 8-category post-hoc diagnosis (#106) ──────────────────────────────────────
//
// Reference: Clauditor's `DiagnosisReport` and `analyze_session()`. Each
// category is derived from JSONL-only signals (no OTEL, no API quota) so
// this module remains a pure function over `UsageTurn[]` and runs
// identically against file-parse and DB-rehydrated turns.

export type DiagnosisCategory =
  | "cache-ttl-expiry"
  | "cache-thrash"
  | "context-bloat"
  | "near-compaction"
  | "compaction-loop"
  | "tool-failure-streak"
  | "high-idle"
  | "context-dominated";

export type DiagnosisSeverity = "P0" | "P1" | "P2";

export interface DiagnosisFinding {
  category: DiagnosisCategory;
  severity: DiagnosisSeverity;
  /** One-line problem statement, ready to render in the panel. */
  finding: string;
  /** One-line corrective advice. */
  advice: string;
  /**
   * Approximate dollar impact, when calculable. Used for advice
   * prioritization in `topAdvice`. Negative values are treated as zero
   * (the cache paid back more than it cost — surface for context, not
   * remediation).
   */
  estimatedImpactUsd?: number;
}

export type SessionOutcome = "completed" | "partial" | "abandoned" | "stuck";

export interface DiagnosisReport {
  sessionId: string;
  outcome: SessionOutcome;
  cache: CacheStats;
  /** Peak input/window ratio across assistant turns, in [0, 1]. */
  maxContextFill: number;
  /** Sum of inter-turn idle gaps (seconds), excluding gaps over 12 hours. */
  totalIdleSeconds: number;
  findings: DiagnosisFinding[];
  /** Up to 3 advice strings, ordered by estimated impact desc. */
  topAdvice: string[];
  generatedAt: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const CACHE_TTL_GAP_SECONDS = 300;            // Anthropic prompt cache TTL
const CACHE_THRASH_WINDOW_SECONDS = 300;
const CACHE_THRASH_MIN_SPIKES = 3;
const CACHE_CREATION_SPIKE_TOKENS = 5_000;    // "spike" = ≥5K cache_create
const CONTEXT_BLOAT_THRESHOLD = 0.60;
const NEAR_COMPACTION_THRESHOLD = 0.83;
// Invariant: CONTEXT_BLOAT_THRESHOLD < NEAR_COMPACTION_THRESHOLD — the bloat
// finding is intentionally suppressed when near-compaction also fires.
const HIGH_IDLE_THRESHOLD_SECONDS = 30 * 60;  // 30 min of dead air feels like a stuck session
const HUGE_GAP_CAP_SECONDS = 12 * 60 * 60;    // anything bigger is a literal break, not idle
const CONTEXT_DOMINATED_RATIO = 10;           // input >= 10× output → context-dominated turn
const CONTEXT_DOMINATED_MIN_INPUT = 50_000;   // small turns don't matter even at high ratio
const CONTEXT_DOMINATED_FRACTION = 0.30;      // ≥30% of assistant turns must trigger
// Stuck-outcome cliffs — outcome flips to `stuck` when EITHER a compaction
// loop run reached this many qualifying pairs OR a tool-failure streak
// extended to this many consecutive evaluable turns. Both inferOutcome
// branches share the spirit of the threshold ("a streak/loop big enough
// to overrule the simpler trailing-turn read").
const STUCK_OUTCOME_LOOP_PAIRS = 3;
const STUCK_OUTCOME_STREAK_WINDOW = 8;
// Severity rank used by topAdvice prioritization. P0 dominates impact;
// P1 dominates impact-less P2; impact USD adds within a tier.
const SEVERITY_RANK: Record<DiagnosisSeverity, number> = {
  P0: 10_000,
  P1: 1_000,
  P2: 100,
};
// Approximate cost-per-token used to estimate compaction-loop dollar
// impact for advice prioritization. Mirrors the Sonnet cache-read rate;
// the absolute number doesn't need to be exact — it's a relative
// magnitude that ranks loops with more turns above smaller ones.
const LOOP_IMPACT_RATE_PER_TOKEN = 0.0000003;

// ── Public API ────────────────────────────────────────────────────────────────

export function diagnoseSession(sessionId: string, turns: UsageTurn[]): DiagnosisReport {
  const quality = computeSessionQuality(turns);
  const findings: DiagnosisFinding[] = [];

  // (1) Cache TTL expiry — gap exceeds the 5-minute cache lifetime.
  const ttlExpired = countCacheTtlExpiries(turns);
  if (ttlExpired.count > 0) {
    findings.push({
      category: "cache-ttl-expiry",
      severity: ttlExpired.count >= 3 ? "P1" : "P2",
      finding: `${ttlExpired.count} inter-turn gap${ttlExpired.count === 1 ? "" : "s"} exceeded the 5-minute cache TTL`,
      advice:
        "Long pauses invalidate the prompt cache. If you're stepping away, prefer a fresh `claude` invocation when you return rather than continuing the same session — the cache rebuild cost is incurred either way.",
    });
  }

  // (2) Cache thrash — repeated cache_creation spikes within a 5-minute window.
  const thrashRuns = detectCacheThrash(turns);
  if (thrashRuns > 0) {
    findings.push({
      category: "cache-thrash",
      severity: thrashRuns >= 2 ? "P0" : "P1",
      finding: `${thrashRuns} run${thrashRuns === 1 ? "" : "s"} of repeated cache rebuilds within 5 minutes`,
      advice:
        "Three or more cache rebuilds in a window means the system message or memory is changing under you. Check for instructions that mutate per-turn (timestamps, random IDs, file-listing variance) and pin them.",
      estimatedImpactUsd: Math.max(0, quality.cache.rebuildWasteUsd),
    });
  }

  // (3) Context bloat — any single turn >60% fill.
  const bloatTurns = countTurnsAboveFill(turns, CONTEXT_BLOAT_THRESHOLD);
  if (bloatTurns > 0 && quality.maxContextFill <= NEAR_COMPACTION_THRESHOLD) {
    // Suppress when (4) near-compaction would also fire — the more severe
    // finding subsumes the weaker one. Prevents redundant advice.
    findings.push({
      category: "context-bloat",
      severity: "P2",
      finding: `${bloatTurns} turn${bloatTurns === 1 ? "" : "s"} exceeded 60% of the model's context window`,
      advice:
        "Trim the prompt: archive long file contents to disk and re-read on demand, prune chat history with a manual `/compact`, or split the work into multiple sessions.",
    });
  }

  // (4) Near-compaction — any single turn >83% (within ~2 turns of auto-compact).
  if (quality.maxContextFill > NEAR_COMPACTION_THRESHOLD) {
    findings.push({
      category: "near-compaction",
      severity: "P1",
      finding: `Peak context fill reached ${(quality.maxContextFill * 100).toFixed(0)}% — within striking distance of auto-compaction`,
      advice:
        "Auto-compaction kicks in around 85% and rebuilds the cache from scratch. Run `/compact` manually with a tight summary now to control what survives, or branch the work into a fresh session.",
    });
  }

  // (5) Compaction loop — pre-detected by sessionQuality.
  if (quality.compactionLoops.length > 0) {
    const totalPairs = quality.compactionLoops.reduce((sum, l) => sum + l.pairCount, 0);
    findings.push({
      category: "compaction-loop",
      severity: totalPairs >= 5 ? "P0" : "P1",
      finding: `${quality.compactionLoops.length} compaction-loop run${quality.compactionLoops.length === 1 ? "" : "s"} (${totalPairs} stalled turn pair${totalPairs === 1 ? "" : "s"})`,
      advice:
        "Token use is steady but progress is not. Stop the session, take what's there, and restart with a more concrete next step — Claude is going around in circles.",
      estimatedImpactUsd: estimateCompactionLoopImpact(turns, quality.compactionLoops),
    });
  }

  // (6) Tool-failure streak — pre-detected by sessionQuality.
  if (quality.toolFailureStreaks.length > 0) {
    const longest = quality.toolFailureStreaks.reduce((a, b) =>
      b.windowSize > a.windowSize ? b : a
    );
    findings.push({
      category: "tool-failure-streak",
      severity: longest.windowSize >= 10 ? "P0" : "P1",
      finding: `Tool-failure streak: ${longest.failureCount} of ${longest.windowSize} consecutive results errored (${(longest.failureRate * 100).toFixed(0)}%)`,
      advice:
        "When tools are failing back-to-back, intervene rather than letting Claude retry the same approach. Check the underlying error and fix the root cause manually.",
    });
  }

  // (7) High idle — total dead air across the session.
  const idleSummary = computeIdleSummary(turns);
  if (idleSummary.totalSeconds > HIGH_IDLE_THRESHOLD_SECONDS) {
    findings.push({
      category: "high-idle",
      severity: idleSummary.totalSeconds > HIGH_IDLE_THRESHOLD_SECONDS * 4 ? "P1" : "P2",
      finding: `${formatDuration(idleSummary.totalSeconds)} of inter-turn idle time across this session`,
      advice:
        "Long idle stretches keep the conversation 'open' but stale. Cache decays during these gaps; if you're stepping away, end the session and resume fresh.",
    });
  }

  // (8) Context-dominated turns — input dwarfs output for a sizable fraction.
  const dominatedFraction = computeContextDominatedFraction(turns);
  if (dominatedFraction.fraction > CONTEXT_DOMINATED_FRACTION) {
    findings.push({
      category: "context-dominated",
      severity: dominatedFraction.fraction > 0.5 ? "P1" : "P2",
      finding: `${(dominatedFraction.fraction * 100).toFixed(0)}% of assistant turns spent ≥${CONTEXT_DOMINATED_RATIO}× more on context than on output`,
      advice:
        "When the model rereads more than it writes, you're paying input rates for repeat context. Lean on prompt caching by reusing the same system message and bring file contents in via Read tool calls only when needed.",
    });
  }

  // ── Outcome inference ──────────────────────────────────────────────────────
  const outcome = inferOutcome(turns, quality.toolFailureStreaks, quality.compactionLoops);

  // ── Top 3 advice — prioritize by estimated impact desc, falling back to severity. ─
  const topAdvice = pickTopAdvice(findings, 3);

  return {
    sessionId,
    outcome,
    cache: quality.cache,
    maxContextFill: quality.maxContextFill,
    totalIdleSeconds: idleSummary.totalSeconds,
    findings,
    topAdvice,
    generatedAt: new Date().toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface CacheTtlSummary {
  count: number;
}

function countCacheTtlExpiries(turns: UsageTurn[]): CacheTtlSummary {
  let count = 0;
  let prevTs: number | null = null;
  for (const t of turns) {
    const ts = Date.parse(t.timestamp);
    if (Number.isNaN(ts)) continue;
    if (prevTs !== null) {
      const gap = (ts - prevTs) / 1000;
      // Only count gaps that aren't huge breaks (those are "I went home")
      // — TTL expiry is meaningful within the working envelope.
      if (gap > CACHE_TTL_GAP_SECONDS && gap < HUGE_GAP_CAP_SECONDS) count++;
    }
    prevTs = ts;
  }
  return { count };
}

function detectCacheThrash(turns: UsageTurn[]): number {
  // A "spike" is an assistant turn whose cache_create exceeds the threshold.
  // We slide a 5-minute window over spike timestamps and count it as a
  // thrash run when ≥3 spikes fall in the same window. Greedy: each
  // qualifying window consumes its spikes so we report one run per cluster.
  const spikes: number[] = [];
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    if (t.cacheCreateTokens < CACHE_CREATION_SPIKE_TOKENS) continue;
    const ts = Date.parse(t.timestamp);
    if (!Number.isNaN(ts)) spikes.push(ts);
  }
  if (spikes.length < CACHE_THRASH_MIN_SPIKES) return 0;

  spikes.sort((a, b) => a - b);
  const windowMs = CACHE_THRASH_WINDOW_SECONDS * 1000;
  let runs = 0;
  let i = 0;
  while (i <= spikes.length - CACHE_THRASH_MIN_SPIKES) {
    if (spikes[i + CACHE_THRASH_MIN_SPIKES - 1] - spikes[i] <= windowMs) {
      runs++;
      // Skip past the cluster — extend `j` while it still falls in the window.
      let j = i + CACHE_THRASH_MIN_SPIKES;
      while (j < spikes.length && spikes[j] - spikes[i] <= windowMs) j++;
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

function countTurnsAboveFill(turns: UsageTurn[], threshold: number): number {
  // Per TODO #102's spec: fill = `input_tokens / window`. See
  // sessionQuality.detectCompactionLoops for why this measures
  // cache-effectiveness rather than literal window position.
  let count = 0;
  for (const t of turns) {
    if (t.role !== "assistant" || t.inputTokens <= 0) continue;
    const window = getModelContextWindow(t.model);
    if (t.inputTokens / window > threshold) count++;
  }
  return count;
}

interface IdleSummary {
  totalSeconds: number;
}

function computeIdleSummary(turns: UsageTurn[]): IdleSummary {
  let total = 0;
  let prevTs: number | null = null;
  for (const t of turns) {
    const ts = Date.parse(t.timestamp);
    if (Number.isNaN(ts)) continue;
    if (prevTs !== null) {
      const gap = (ts - prevTs) / 1000;
      // Per the TODO spec ("sum of inter-turn gaps"). Cap each gap to
      // skip "I went home" breaks; without this, an overnight pause
      // dominates the metric and obscures genuine in-session idle.
      if (gap > 0 && gap < HUGE_GAP_CAP_SECONDS) total += gap;
    }
    prevTs = ts;
  }
  return { totalSeconds: total };
}

interface DominatedSummary {
  dominatedTurns: number;
  totalAssistantTurns: number;
  fraction: number;
}

function computeContextDominatedFraction(turns: UsageTurn[]): DominatedSummary {
  // Uses input_tokens for parity with the fill semantic — when input
  // tokens dominate output, the model is reading new content faster
  // than producing useful output.
  let dominated = 0;
  let assistantTurns = 0;
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    if (t.inputTokens <= 0) continue;
    assistantTurns++;
    if (t.inputTokens < CONTEXT_DOMINATED_MIN_INPUT) continue;
    if (t.outputTokens === 0 || t.inputTokens / Math.max(t.outputTokens, 1) >= CONTEXT_DOMINATED_RATIO) {
      dominated++;
    }
  }
  return {
    dominatedTurns: dominated,
    totalAssistantTurns: assistantTurns,
    fraction: assistantTurns > 0 ? dominated / assistantTurns : 0,
  };
}

function estimateCompactionLoopImpact(
  turns: UsageTurn[],
  loops: CompactionFinding[]
): number {
  // Approximate: sum the assistant-turn cost of every turn inside a loop
  // run. We don't have per-turn cost on UsageTurn here, so we approximate
  // via input_tokens × the read-side rate. Conservative — caller treats
  // negative as zero, so a low estimate is fine.
  let usd = 0;
  for (const loop of loops) {
    for (let i = loop.startIndex; i <= loop.endIndex; i++) {
      const t = turns[i];
      if (!t || t.role !== "assistant") continue;
      usd += t.inputTokens * LOOP_IMPACT_RATE_PER_TOKEN;
    }
  }
  return usd;
}

function inferOutcome(
  turns: UsageTurn[],
  failureStreaks: StreakFinding[],
  compactionLoops: CompactionFinding[]
): SessionOutcome {
  if (turns.length === 0) return "abandoned";
  // "Stuck" wins when there's persistent failure or active loop signal —
  // the trailing-turn shape can't see those, but they trump the simpler
  // finished/abandoned read.
  if (compactionLoops.length > 0 && compactionLoops.some((l) => l.pairCount >= STUCK_OUTCOME_LOOP_PAIRS)) {
    return "stuck";
  }
  if (failureStreaks.length > 0 && failureStreaks.some((s) => s.windowSize >= STUCK_OUTCOME_STREAK_WINDOW)) {
    return "stuck";
  }
  const last = turns[turns.length - 1];
  if (last.role === "user") return "abandoned";
  // Assistant-final turn with errors → partial; clean assistant-final → completed.
  if (last.isError) return "partial";
  return "completed";
}

function pickTopAdvice(findings: DiagnosisFinding[], max: number): string[] {
  const scored = findings
    .map((f, i) => ({
      f,
      i,
      // Score: estimated impact (clamped at 0), tie-broken by severity rank.
      score: Math.max(f.estimatedImpactUsd ?? 0, 0) + SEVERITY_RANK[f.severity],
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, max).map((s) => s.f.advice);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
