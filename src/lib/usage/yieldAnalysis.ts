import type { UsageTurn } from "./types";
import type { CommitMeta } from "@/lib/scanner/git";

// Session yield analysis. Given session intervals + the project's
// main-branch commit log, classify each session as:
//
//   • Productive — session interval overlaps >=1 commit that reached
//     main/master AND was not later reverted.
//   • Reverted   — >=50% of the session's commits were later reverted
//     (matched by `Revert "<subject>"` in subsequent commit messages).
//   • Abandoned  — session produced zero commits (session interval
//     contains no commits on the main branch).
//
// The yield rate = productiveSessions / totalSessions. We also derive
// dollars-per-shipped-commit = totalSessionCost / nonRevertedCommitCount
// when cost data is provided.
//
// Caveats:
//   - Session "interval" is the half-open [start, end] of the assistant
//     turn timestamps in the JSONL. A commit attribution requires the
//     commit's date to fall inside that window. This will misattribute
//     when (a) the user finalizes work after the session ends, or
//     (b) two sessions overlap on the same window. Best heuristic
//     available without OTEL or hook-server data; documented so
//     downstream consumers don't over-trust the metric.
//   - Revert detection is text-based against commit subjects. The
//     standard `git revert` produces `Revert "<subject>"` and references
//     the original SHA in the body. We match the subject form; if a
//     project uses custom revert messaging, classification may
//     under-count.

export type YieldOutcome = "productive" | "reverted" | "abandoned";

export interface SessionInterval {
  sessionId: string;
  /** ISO timestamp of the first assistant turn. */
  startMs: number;
  /** ISO timestamp of the last assistant turn (or start, if single-turn). */
  endMs: number;
  /** Total session cost in USD across assistant turns; optional. */
  costUsd?: number;
}

export interface SessionYield {
  sessionId: string;
  outcome: YieldOutcome;
  /** SHAs of main-branch commits that fell inside this session's interval. */
  attributedCommits: string[];
  /** Subset of `attributedCommits` that were later reverted. */
  revertedCommits: string[];
}

export interface YieldReport {
  totalSessions: number;
  productive: number;
  reverted: number;
  abandoned: number;
  /** productive / totalSessions; 0 when totalSessions is 0. */
  yieldRate: number;
  /**
   * Total session cost / commits-that-stuck. `null` when no commits stuck
   * or no cost data is available. Surface as "—" in the UI in that case.
   */
  dollarsPerShippedCommit: number | null;
  perSession: SessionYield[];
}

/**
 * Build the per-session intervals from a project's full set of turns.
 * Earliest assistant turn timestamp wins for `startMs`; latest for
 * `endMs`. Sessions with zero assistant turns are skipped (no signal
 * to compare against the commit log).
 */
export function buildSessionIntervals(
  turns: UsageTurn[],
  costForTurn?: (t: UsageTurn) => number
): SessionInterval[] {
  const map = new Map<string, { start: number; end: number; cost: number }>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts)) continue;
    const existing = map.get(t.sessionId);
    const cost = costForTurn ? costForTurn(t) : 0;
    if (!existing) {
      map.set(t.sessionId, { start: ts, end: ts, cost });
    } else {
      if (ts < existing.start) existing.start = ts;
      if (ts > existing.end) existing.end = ts;
      existing.cost += cost;
    }
  }
  const intervals: SessionInterval[] = [];
  for (const [sessionId, v] of map.entries()) {
    intervals.push({
      sessionId,
      startMs: v.start,
      endMs: v.end,
      costUsd: costForTurn ? v.cost : undefined,
    });
  }
  return intervals.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Detect reverted commit SHAs from a commit log.
 *
 * We match the subject form `Revert "<original subject>"` (the default
 * produced by `git revert`) by stripping the wrapper and looking up the
 * inner subject in our subject->SHAs map. Body lines like
 * `This reverts commit <sha>` are NOT parsed: that requires loading
 * commit bodies (`%b`), which can balloon to many MB on long-lived
 * repos. The subject form catches the common case and keeps the metric
 * conservative.
 *
 * Returns the set of SHAs that were reverted by some later commit. Note
 * the reverting commit itself is NOT in this set (it shipped).
 */
export function detectRevertedCommits(commits: CommitMeta[]): Set<string> {
  const subjectToShas = new Map<string, string[]>();
  for (const c of commits) {
    const arr = subjectToShas.get(c.subject) ?? [];
    arr.push(c.sha);
    subjectToShas.set(c.subject, arr);
  }

  const reverted = new Set<string>();
  // `Revert "subject"` — the inner quoted string is the original subject.
  const revertRe = /^Revert "(.+)"$/;
  for (const c of commits) {
    const m = revertRe.exec(c.subject);
    if (!m) continue;
    const innerSubject = m[1];
    const candidates = subjectToShas.get(innerSubject);
    if (!candidates) continue;
    // Multiple commits can share a subject (e.g. "fix typo"); when that
    // happens we mark all matching SHAs as reverted. Without commit-graph
    // data we approximate — the false-positive case (a subject reused
    // after a revert) is rare and yields a strictly conservative metric.
    for (const sha of candidates) {
      if (sha !== c.sha) reverted.add(sha);
    }
  }
  return reverted;
}

/**
 * Given commits with timestamps and a session interval, find the commits
 * whose date falls inside [start, end]. We add a 5-minute grace at both
 * ends because finalizing work right after the last assistant turn (and
 * immediately before the next session starts) is a common pattern —
 * without grace, those commits would be classified as "abandoned"
 * instead of attributed.
 *
 * Callers that classify many sessions against the same commit log
 * should use `prepareCommitIndex` once and pass the result to
 * `commitsInIntervalIndexed`. The naïve filter below would re-parse
 * every commit timestamp on every call, costing O(numSessions ×
 * numCommits) `Date.parse` calls.
 */
const COMMIT_ATTRIBUTION_GRACE_MS = 5 * 60 * 1000;

interface IndexedCommit {
  meta: CommitMeta;
  ms: number;
}

/** Parse all commit timestamps once and sort ascending so per-interval
 *  lookups can binary-search for the interval lower bound. */
function prepareCommitIndex(commits: CommitMeta[]): IndexedCommit[] {
  const indexed: IndexedCommit[] = [];
  for (const c of commits) {
    const ms = Date.parse(c.date);
    if (Number.isFinite(ms)) indexed.push({ meta: c, ms });
  }
  indexed.sort((a, b) => a.ms - b.ms);
  return indexed;
}

/** Lowest index `i` such that `indexed[i].ms >= target`, or `length`. */
function lowerBound(indexed: IndexedCommit[], target: number): number {
  let lo = 0;
  let hi = indexed.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (indexed[mid].ms < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function commitsInIntervalIndexed(
  indexed: IndexedCommit[],
  interval: SessionInterval
): CommitMeta[] {
  const lo = interval.startMs - COMMIT_ATTRIBUTION_GRACE_MS;
  const hi = interval.endMs + COMMIT_ATTRIBUTION_GRACE_MS;
  const start = lowerBound(indexed, lo);
  const out: CommitMeta[] = [];
  for (let i = start; i < indexed.length; i++) {
    if (indexed[i].ms > hi) break;
    out.push(indexed[i].meta);
  }
  return out;
}

export interface YieldAnalysisInput {
  intervals: SessionInterval[];
  commits: CommitMeta[];
}

/** Tagged result so consumers can `switch (r.kind)` exhaustively. The
 *  `unavailable` branch carries a human-readable reason that the UI
 *  surfaces verbatim. */
export type YieldResult =
  | { kind: "ok"; report: YieldReport }
  | { kind: "unavailable"; reason: string };

export function classifySessionsByYield(input: YieldAnalysisInput): YieldReport {
  const { intervals, commits } = input;
  const reverted = detectRevertedCommits(commits);
  const indexedCommits = prepareCommitIndex(commits);

  const perSession: SessionYield[] = [];
  let productive = 0;
  let revertedSessions = 0;
  let abandoned = 0;
  let totalCost = 0;
  let stuckCommits = 0;
  // Track whether ANY interval carried cost data, separately from the
  // sum being non-zero. A free-tier project with `costUsd: 0` on every
  // turn would otherwise be indistinguishable from "no cost data
  // provided" — we want $0/commit in the first case, "—" in the second.
  let hasCostData = false;

  for (const iv of intervals) {
    const attributed = commitsInIntervalIndexed(indexedCommits, iv);
    const attributedShas = attributed.map((c) => c.sha);
    const revertedAttributed = attributedShas.filter((sha) => reverted.has(sha));

    let outcome: YieldOutcome;
    if (attributedShas.length === 0) {
      outcome = "abandoned";
      abandoned++;
    } else if (revertedAttributed.length / attributedShas.length >= 0.5) {
      outcome = "reverted";
      revertedSessions++;
    } else {
      outcome = "productive";
      productive++;
    }
    // Shipped-commit denominator counts non-reverted commits regardless
    // of session classification: a "reverted" session can still have
    // surviving commits (≥50% reverted ≠ all reverted), and excluding
    // them would inflate $/shipped-commit on projects with mixed-outcome
    // sessions.
    if (attributedShas.length > 0) {
      stuckCommits += attributedShas.length - revertedAttributed.length;
    }
    if (typeof iv.costUsd === "number") {
      totalCost += iv.costUsd;
      hasCostData = true;
    }

    perSession.push({
      sessionId: iv.sessionId,
      outcome,
      attributedCommits: attributedShas,
      revertedCommits: revertedAttributed,
    });
  }

  const totalSessions = intervals.length;
  const yieldRate = totalSessions > 0 ? productive / totalSessions : 0;
  const dollarsPerShippedCommit =
    hasCostData && stuckCommits > 0 ? totalCost / stuckCommits : null;

  return {
    totalSessions,
    productive,
    reverted: revertedSessions,
    abandoned,
    yieldRate,
    dollarsPerShippedCommit,
    perSession,
  };
}
