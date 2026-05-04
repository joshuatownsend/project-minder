import { describe, it, expect } from "vitest";
import {
  buildSessionIntervals,
  detectRevertedCommits,
  classifySessionsByYield,
  type SessionInterval,
} from "@/lib/usage/yieldAnalysis";
import type { UsageTurn } from "@/lib/usage/types";
import type { CommitMeta } from "@/lib/scanner/git";

function turn(args: Partial<UsageTurn> & {
  role: "user" | "assistant";
  sessionId: string;
  timestamp: string;
}): UsageTurn {
  return {
    projectSlug: "p",
    projectDirName: "p",
    model: "claude-sonnet-4-6",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...args,
  };
}

function commit(sha: string, dateIso: string, subject: string): CommitMeta {
  return { sha, date: dateIso, subject };
}

// ── buildSessionIntervals ───────────────────────────────────────────────────

describe("buildSessionIntervals", () => {
  it("computes start/end per session from assistant turns only", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T10:00:00Z" }),
      turn({ role: "user", sessionId: "s1", timestamp: "2026-01-01T11:00:00Z" }),
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T12:00:00Z" }),
      turn({ role: "assistant", sessionId: "s2", timestamp: "2026-01-02T10:00:00Z" }),
    ];
    const intervals = buildSessionIntervals(turns);
    expect(intervals).toHaveLength(2);
    const s1 = intervals.find((i) => i.sessionId === "s1")!;
    expect(new Date(s1.startMs).toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(new Date(s1.endMs).toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("skips sessions with zero assistant turns", () => {
    const turns: UsageTurn[] = [
      turn({ role: "user", sessionId: "s1", timestamp: "2026-01-01T10:00:00Z" }),
    ];
    expect(buildSessionIntervals(turns)).toHaveLength(0);
  });

  it("aggregates per-turn cost when callback provided", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T10:00:00Z" }),
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T11:00:00Z" }),
    ];
    const intervals = buildSessionIntervals(turns, () => 0.05);
    expect(intervals[0].costUsd).toBeCloseTo(0.10);
  });

  it("leaves costUsd undefined when no callback is provided", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T10:00:00Z" }),
    ];
    const intervals = buildSessionIntervals(turns);
    expect(intervals[0].costUsd).toBeUndefined();
  });

  it("skips turns with unparseable timestamps without poisoning min/max", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", timestamp: "not-a-date" }),
      turn({ role: "assistant", sessionId: "s1", timestamp: "2026-01-01T10:00:00Z" }),
    ];
    const intervals = buildSessionIntervals(turns);
    expect(intervals).toHaveLength(1);
    expect(Number.isFinite(intervals[0].startMs)).toBe(true);
    expect(intervals[0].startMs).toBe(intervals[0].endMs);
  });
});

// ── detectRevertedCommits ───────────────────────────────────────────────────

describe("detectRevertedCommits", () => {
  it("matches Revert \"<subject>\" form", () => {
    const commits: CommitMeta[] = [
      commit("abc1", "2026-01-01T00:00:00Z", "feat: add login"),
      commit("abc2", "2026-01-02T00:00:00Z", "Revert \"feat: add login\""),
    ];
    const reverted = detectRevertedCommits(commits);
    expect(reverted.has("abc1")).toBe(true);
    // The reverting commit is NOT in the set — it shipped.
    expect(reverted.has("abc2")).toBe(false);
  });

  it("does not flag normal commits", () => {
    const commits: CommitMeta[] = [
      commit("abc1", "2026-01-01T00:00:00Z", "feat: add login"),
      commit("abc2", "2026-01-02T00:00:00Z", "fix: typo in login"),
    ];
    expect(detectRevertedCommits(commits).size).toBe(0);
  });

  it("handles a revert with no matching original (no-op)", () => {
    const commits: CommitMeta[] = [
      commit("abc1", "2026-01-01T00:00:00Z", "Revert \"nonexistent feature\""),
    ];
    expect(detectRevertedCommits(commits).size).toBe(0);
  });

  it("flags both candidates when a subject collides (conservative over-count)", () => {
    // Two `feat: x` commits + one revert → both originals marked
    // reverted. Without the commit-graph we can't tell which one was
    // the target; we strictly over-count.
    const commits: CommitMeta[] = [
      commit("aaa1", "2026-01-01T00:00:00Z", "feat: x"),
      commit("aaa2", "2026-01-02T00:00:00Z", "feat: x"),
      commit("rev1", "2026-01-03T00:00:00Z", "Revert \"feat: x\""),
    ];
    const reverted = detectRevertedCommits(commits);
    expect(reverted.has("aaa1")).toBe(true);
    expect(reverted.has("aaa2")).toBe(true);
    // Reverting commit itself is not reverted.
    expect(reverted.has("rev1")).toBe(false);
  });
});

// ── classifySessionsByYield ─────────────────────────────────────────────────

describe("classifySessionsByYield", () => {
  function iv(sessionId: string, startIso: string, endIso: string, cost?: number): SessionInterval {
    return {
      sessionId,
      startMs: Date.parse(startIso),
      endMs: Date.parse(endIso),
      costUsd: cost,
    };
  }

  it("classifies a productive session", () => {
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")];
    const commits = [commit("abc1", "2026-01-01T11:00:00Z", "feat: x")];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.productive).toBe(1);
    expect(r.reverted).toBe(0);
    expect(r.abandoned).toBe(0);
    expect(r.yieldRate).toBe(1);
  });

  it("classifies a reverted session", () => {
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")];
    const commits = [
      commit("abc1", "2026-01-01T11:00:00Z", "feat: x"),
      // The revert lands later (outside the session window).
      commit("abc2", "2026-01-05T00:00:00Z", "Revert \"feat: x\""),
    ];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.reverted).toBe(1);
    expect(r.productive).toBe(0);
  });

  it("classifies an abandoned session", () => {
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")];
    // Commit far outside the session window → not attributed.
    const commits = [commit("abc1", "2026-02-01T00:00:00Z", "feat: x")];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.abandoned).toBe(1);
    expect(r.productive).toBe(0);
  });

  it("dollarsPerShippedCommit reflects cost / non-reverted commit count", () => {
    const intervals = [
      iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z", 1.50),
      iv("s2", "2026-01-02T10:00:00Z", "2026-01-02T12:00:00Z", 0.50),
    ];
    const commits = [
      commit("abc1", "2026-01-01T11:00:00Z", "feat: x"),
      commit("abc2", "2026-01-02T11:00:00Z", "feat: y"),
    ];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.dollarsPerShippedCommit).toBeCloseTo(1.0);
  });

  it("returns null dollarsPerShippedCommit when no commits stuck", () => {
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z", 0.50)];
    const commits: CommitMeta[] = []; // abandoned
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.dollarsPerShippedCommit).toBeNull();
  });

  it("returns null dollarsPerShippedCommit when costUsd is omitted entirely", () => {
    // No costUsd anywhere — the metric should be "unavailable" (null),
    // not "$0/commit". Distinguishing this from a $0 free-tier project
    // is the whole point of tracking hasCostData separately.
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")]; // no cost
    const commits = [commit("abc1", "2026-01-01T11:00:00Z", "feat: x")];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.dollarsPerShippedCommit).toBeNull();
  });

  it("returns $0/commit when cost data is provided but every cost is 0", () => {
    // Free-tier project: real cost data, just all zeroes. Must NOT
    // return null — that would conflate "unavailable" with "free".
    const intervals = [
      iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z", 0),
      iv("s2", "2026-01-02T10:00:00Z", "2026-01-02T12:00:00Z", 0),
    ];
    const commits = [
      commit("abc1", "2026-01-01T11:00:00Z", "feat: x"),
      commit("abc2", "2026-01-02T11:00:00Z", "feat: y"),
    ];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.dollarsPerShippedCommit).toBe(0);
  });

  it("majority-revert threshold: 50%+ reverted classifies session as reverted", () => {
    const intervals = [iv("s1", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")];
    const commits = [
      commit("abc1", "2026-01-01T11:00:00Z", "feat: x"),
      commit("abc2", "2026-01-01T11:30:00Z", "feat: y"),
      // Only abc1 is reverted (50% of 2 = exactly threshold).
      commit("abc3", "2026-01-05T00:00:00Z", "Revert \"feat: x\""),
    ];
    const r = classifySessionsByYield({ intervals, commits });
    expect(r.reverted).toBe(1);
  });

  it("handles empty inputs", () => {
    const r = classifySessionsByYield({ intervals: [], commits: [] });
    expect(r.totalSessions).toBe(0);
    expect(r.yieldRate).toBe(0);
    expect(r.dollarsPerShippedCommit).toBeNull();
  });
});
