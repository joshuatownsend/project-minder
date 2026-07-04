/**
 * Composition characterization test for `aggregateUsage` (src/lib/usage/aggregator.ts).
 *
 * Each sub-module (classifier, costCalculator, oneShotDetector, selfCorrection,
 * shellParser, mcpParser, toolTransitions, activityBuckets) already has its own
 * unit tests. This test pins the COMPOSITION: given a hand-built set of fixture
 * turns spanning multiple sessions/projects/models/categories — including a
 * sidechain (subagent) turn and a cache-heavy turn — does `aggregateUsage`
 * correctly sum, group, sort, and fold them into the final `UsageReport`?
 *
 * "Expected" values below are computed independently in this file (fresh
 * reducers over the same fixture array, using the underlying trusted pure
 * helpers directly), NOT by re-calling `aggregateUsage` — so this test can
 * actually fail if the composition logic in aggregator.ts drifts.
 *
 * Pricing is forced to the hardcoded fallback table (same technique as
 * tests/usage/costCalculator.test.ts) so cost math doesn't depend on network
 * or the on-disk LiteLLM cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UsageTurn } from "@/lib/usage/types";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity, toLocalDateStr } from "@/lib/usage/activityBuckets";
import { classifyTurn } from "@/lib/usage/classifier";
import {
  getModelPricing,
  applyPricing,
  loadPricing,
  _resetForTesting,
} from "@/lib/usage/costCalculator";
import { detectOneShot } from "@/lib/usage/oneShotDetector";
import { detectSelfCorrectionPerModel } from "@/lib/usage/selfCorrection";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.stubGlobal("fetch", vi.fn());

import { promises as fsMock } from "fs";

beforeEach(() => {
  _resetForTesting();
  vi.mocked(fsMock.stat).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fsMock.readFile).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
  vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
  vi.mocked(fetch).mockRejectedValue(new Error("no network"));
});

function turn(overrides: Partial<UsageTurn>): UsageTurn {
  return {
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId: "s",
    projectSlug: "p",
    projectDirName: "p-dir",
    model: "",
    role: "user",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

const SONNET = "claude-sonnet-4-5-20250514";
const OPUS = "claude-opus-4-1-20260301";
const HAIKU = "claude-haiku-4-5-20260101";

// Session "sess-a" (project proj-one): a Git Ops turn, then a genuine
// Edit → verify(Bash test) → clean-result → no-re-edit one-shot task.
// Session "sess-b" (project proj-two, next calendar day): a cache-heavy
// Exploration turn on a different model.
// A sidechain (subagent) turn belonging to a third session id, folded into
// the parent project's totals per A1 but excluded from primary-turn-only
// aggregates (activity, one-shot, self-correction).
const turns: UsageTurn[] = [
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "user",
    timestamp: "2026-06-01T09:00:00.000Z",
    userMessageText: "commit the changes",
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "assistant",
    timestamp: "2026-06-01T09:00:05.000Z",
    model: SONNET,
    inputTokens: 1000,
    outputTokens: 200,
    toolCalls: [{ name: "Bash", arguments: { command: "git commit -am 'wip'" } }],
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "user",
    timestamp: "2026-06-01T09:05:00.000Z",
    userMessageText: "fix the bug in foo.ts",
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "assistant",
    timestamp: "2026-06-01T09:05:05.000Z",
    model: SONNET,
    inputTokens: 400,
    outputTokens: 150,
    toolCalls: [{ name: "Edit", arguments: { file_path: "src/foo.ts" } }],
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "assistant",
    timestamp: "2026-06-01T09:05:10.000Z",
    model: SONNET,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: [{ name: "Bash", arguments: { command: "pnpm test" } }],
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "user",
    timestamp: "2026-06-01T09:05:15.000Z",
    toolResultText: "All 12 tests passed",
  }),
  turn({
    sessionId: "sess-a",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "assistant",
    timestamp: "2026-06-01T09:05:20.000Z",
    model: SONNET,
    inputTokens: 50,
    outputTokens: 20,
    toolCalls: [],
  }),
  turn({
    sessionId: "sess-a-sub1",
    projectSlug: "proj-one",
    projectDirName: "proj-one-dir",
    role: "assistant",
    timestamp: "2026-06-01T09:10:00.000Z",
    model: HAIKU,
    inputTokens: 2000,
    outputTokens: 800,
    toolCalls: [],
    isSidechain: true,
    parentToolUseId: "toolu_01abc",
  }),
  turn({
    sessionId: "sess-b",
    projectSlug: "proj-two",
    projectDirName: "proj-two-dir",
    role: "user",
    timestamp: "2026-06-02T14:00:00.000Z",
    userMessageText: "explore the codebase",
  }),
  turn({
    sessionId: "sess-b",
    projectSlug: "proj-two",
    projectDirName: "proj-two-dir",
    role: "assistant",
    timestamp: "2026-06-02T14:00:10.000Z",
    model: OPUS,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 1000,
    cacheReadTokens: 5000,
    toolCalls: [{ name: "Read", arguments: { file_path: "foo.ts" } }],
  }),
];

const tokensOf = (t: UsageTurn) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens;
const costOf = (t: UsageTurn) => applyPricing(getModelPricing(t.model), t);

describe("aggregateUsage — composition", () => {
  it("composes model/project/category/daily aggregates, subagent breakout, cache-hit rate, and one-shot from raw turns", async () => {
    await loadPricing(); // warm fallback pricing before computing expectations below

    const report = await aggregateUsage(turns, "all", emptyActivity());

    const assistantTurns = turns.filter((t) => t.role === "assistant");
    const primaryTurns = turns.filter((t) => !t.isSidechain);
    const subagentTurns = turns.filter((t) => t.isSidechain);

    expect(report.period).toBe("all");

    // ---- headline totals ----
    const expectedTotalCost = assistantTurns.reduce((sum, t) => sum + costOf(t), 0);
    expect(report.totalCost).toBeCloseTo(expectedTotalCost, 10);

    const expectedTotalTokens = assistantTurns.reduce((sum, t) => sum + tokensOf(t), 0);
    expect(report.totalTokens).toBe(expectedTotalTokens);

    expect(report.totalSessions).toBe(new Set(turns.map((t) => t.sessionId)).size);
    expect(report.totalTurns).toBe(assistantTurns.length);

    // ---- subagent breakout — folded INTO totals, also broken out (A1) ----
    const expectedSubagentCost = subagentTurns.reduce((s, t) => s + costOf(t), 0);
    const expectedSubagentTokens = subagentTurns.reduce((s, t) => s + tokensOf(t), 0);
    expect(report.subagentTokens).toBeGreaterThan(0);
    expect(report.subagentCost).toBeCloseTo(expectedSubagentCost, 10);
    expect(report.subagentTokens).toBe(expectedSubagentTokens);
    expect(report.totalTokens).toBeGreaterThanOrEqual(expectedSubagentTokens);
    expect(report.totalCost).toBeGreaterThanOrEqual(expectedSubagentCost - 1e-12);

    // ---- token breakdown + cache-hit rate (A7: cache-write counted in denominator) ----
    const totalInput = assistantTurns.reduce((s, t) => s + t.inputTokens, 0);
    const totalOutput = assistantTurns.reduce((s, t) => s + t.outputTokens, 0);
    const totalCacheRead = assistantTurns.reduce((s, t) => s + t.cacheReadTokens, 0);
    const totalCacheWrite = assistantTurns.reduce((s, t) => s + t.cacheCreateTokens, 0);
    expect(report.tokens).toEqual({
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    });
    const expectedCacheHitRate = totalCacheRead / (totalCacheRead + totalInput + totalCacheWrite);
    expect(report.cacheHitRate).toBeCloseTo(expectedCacheHitRate, 10);
    expect(report.cacheHitRate).toBeGreaterThan(0); // the opus turn is genuinely cache-heavy

    // ---- byModel: grouped, summed, sorted by cost desc, self-correction joined ----
    const modelGroups = new Map<string, UsageTurn[]>();
    for (const t of assistantTurns) {
      const arr = modelGroups.get(t.model) ?? [];
      arr.push(t);
      modelGroups.set(t.model, arr);
    }
    const selfCorrection = detectSelfCorrectionPerModel(primaryTurns);
    const selfCorrectionByModel = new Map(selfCorrection.byModel.map((s) => [s.model, s] as const));
    const expectedByModel = [...modelGroups.entries()]
      .map(([model, ts]) => {
        const sc = selfCorrectionByModel.get(model);
        return {
          model,
          inputTokens: ts.reduce((s, t) => s + t.inputTokens, 0),
          outputTokens: ts.reduce((s, t) => s + t.outputTokens, 0),
          cacheReadTokens: ts.reduce((s, t) => s + t.cacheReadTokens, 0),
          cacheCreateTokens: ts.reduce((s, t) => s + t.cacheCreateTokens, 0),
          cost: ts.reduce((s, t) => s + costOf(t), 0),
          turns: ts.length,
          selfCorrectionRate: sc && sc.total > 0 ? sc.rate : undefined,
          sessionsAsPrimary: sc && sc.total > 0 ? sc.total : undefined,
        };
      })
      .sort((a, b) => b.cost - a.cost);

    expect(report.byModel).toHaveLength(expectedByModel.length);
    report.byModel.forEach((m, i) => {
      const e = expectedByModel[i];
      expect(m.model).toBe(e.model);
      expect(m.inputTokens).toBe(e.inputTokens);
      expect(m.outputTokens).toBe(e.outputTokens);
      expect(m.cacheReadTokens).toBe(e.cacheReadTokens);
      expect(m.cacheCreateTokens).toBe(e.cacheCreateTokens);
      expect(m.cost).toBeCloseTo(e.cost, 10);
      expect(m.turns).toBe(e.turns);
      expect(m.selfCorrectionRate).toEqual(e.selfCorrectionRate);
      expect(m.sessionsAsPrimary).toEqual(e.sessionsAsPrimary);
    });
    // The subagent-only model (haiku) is excluded from primary-turn self-correction
    // (it's not a user-verified/primary session) — its rate stays undefined.
    const haikuRow = report.byModel.find((m) => m.model === HAIKU);
    expect(haikuRow?.selfCorrectionRate).toBeUndefined();

    // ---- byProject: grouped, summed, sorted by cost desc ----
    const projectGroups = new Map<string, UsageTurn[]>();
    for (const t of assistantTurns) {
      const arr = projectGroups.get(t.projectSlug) ?? [];
      arr.push(t);
      projectGroups.set(t.projectSlug, arr);
    }
    const expectedByProject = [...projectGroups.entries()]
      .map(([projectSlug, ts]) => ({
        projectSlug,
        projectDirName: ts[0].projectDirName,
        tokens: ts.reduce((s, t) => s + tokensOf(t), 0),
        cost: ts.reduce((s, t) => s + costOf(t), 0),
        turns: ts.length,
      }))
      .sort((a, b) => b.cost - a.cost);

    expect(report.byProject).toHaveLength(expectedByProject.length);
    report.byProject.forEach((p, i) => {
      const e = expectedByProject[i];
      expect(p.projectSlug).toBe(e.projectSlug);
      expect(p.tokens).toBe(e.tokens);
      expect(p.cost).toBeCloseTo(e.cost, 10);
      expect(p.turns).toBe(e.turns);
    });
    // proj-one includes the subagent's tokens/cost folded in (A1).
    const projOne = report.byProject.find((p) => p.projectSlug === "proj-one")!;
    expect(projOne.turns).toBe(5); // a1, a2 (edit), a2b (verify), a3, subagent

    // ---- byCategory: grouped via the real classifier, sorted by cost desc ----
    const categoryGroups = new Map<string, UsageTurn[]>();
    for (const t of assistantTurns) {
      const cat = classifyTurn(t);
      const arr = categoryGroups.get(cat) ?? [];
      arr.push(t);
      categoryGroups.set(cat, arr);
    }
    const expectedByCategory = [...categoryGroups.entries()]
      .map(([category, ts]) => ({
        category,
        turns: ts.length,
        tokens: ts.reduce((s, t) => s + tokensOf(t), 0),
        cost: ts.reduce((s, t) => s + costOf(t), 0),
      }))
      .sort((a, b) => b.cost - a.cost);

    expect(report.byCategory).toHaveLength(expectedByCategory.length);
    report.byCategory.forEach((c, i) => {
      const e = expectedByCategory[i];
      expect(c.category).toBe(e.category);
      expect(c.turns).toBe(e.turns);
      expect(c.tokens).toBe(e.tokens);
      expect(c.cost).toBeCloseTo(e.cost, 10);
    });
    // Our fixture deliberately spans multiple categories (Git Ops, Coding,
    // Conversation, Exploration).
    expect(new Set(report.byCategory.map((c) => c.category)).size).toBeGreaterThanOrEqual(3);

    // ---- daily buckets (local date, per A2) ----
    const dailyGroups = new Map<string, UsageTurn[]>();
    for (const t of assistantTurns) {
      const d = toLocalDateStr(t.timestamp);
      const arr = dailyGroups.get(d) ?? [];
      arr.push(t);
      dailyGroups.set(d, arr);
    }
    const expectedDaily = [...dailyGroups.entries()]
      .map(([date, ts]) => ({
        date,
        cost: ts.reduce((s, t) => s + costOf(t), 0),
        inputTokens: ts.reduce((s, t) => s + t.inputTokens, 0),
        outputTokens: ts.reduce((s, t) => s + t.outputTokens, 0),
        turns: ts.length,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    expect(report.daily).toHaveLength(expectedDaily.length);
    // The fixture spans a ~29h gap, which can never collapse into a single
    // local calendar day under any timezone offset.
    expect(report.daily.length).toBeGreaterThanOrEqual(2);
    report.daily.forEach((d, i) => {
      const e = expectedDaily[i];
      expect(d.date).toBe(e.date);
      expect(d.turns).toBe(e.turns);
      expect(d.inputTokens).toBe(e.inputTokens);
      expect(d.outputTokens).toBe(e.outputTokens);
      expect(d.cost).toBeCloseTo(e.cost, 10);
    });

    // ---- one-shot aggregate (primary turns only, grouped by session) ----
    const bySession = new Map<string, UsageTurn[]>();
    for (const t of primaryTurns) {
      const arr = bySession.get(t.sessionId) ?? [];
      arr.push(t);
      bySession.set(t.sessionId, arr);
    }
    let expVerified = 0;
    let expOneShot = 0;
    for (const sessionTurns of bySession.values()) {
      const stats = detectOneShot(sessionTurns);
      expVerified += stats.totalVerifiedTasks;
      expOneShot += stats.oneShotTasks;
    }
    expect(report.oneShot.totalVerifiedTasks).toBe(expVerified);
    expect(report.oneShot.oneShotTasks).toBe(expOneShot);
    expect(report.oneShot.rate).toBeCloseTo(
      expVerified > 0 ? expOneShot / expVerified : 0,
      10
    );
    // The fixture's sess-a includes a deliberate Edit → verify → clean
    // result → no-re-edit sequence, so this must be non-trivial (not 0/0).
    expect(report.oneShot.totalVerifiedTasks).toBeGreaterThan(0);
    expect(report.oneShot.oneShotTasks).toBeGreaterThan(0);

    // ---- activity passthrough — aggregateUsage doesn't recompute these,
    // it just forwards whatever ActivityData the caller supplied ----
    const empty = emptyActivity();
    expect(report.byHourOfDay).toEqual(empty.byHourOfDay);
    expect(report.byDayOfWeek).toEqual(empty.byDayOfWeek);
    expect(report.byHourDay).toEqual(empty.byHourDay);
    expect(report.streak).toEqual(empty.streak);
    expect(report.contributionCalendar).toEqual(empty.contributionCalendar);
  });
});
