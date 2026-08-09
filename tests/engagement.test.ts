import { describe, it, expect } from "vitest";
import { isHumanPrompt, isHumanInterrupt } from "@/lib/engagement/classifier";
import { buildAttendedBlocks, blockHours } from "@/lib/engagement/blocks";
import {
  mergeIntervals, allocateConcurrent, localDayKey, startOfNextLocalDay,
  equalSplitPolicy, primaryWinsPolicy,
} from "@/lib/engagement/allocate";
import { buildEngagementReport, type EngagementTurnRow } from "@/lib/engagement/aggregator";
import { resolveEngagementConfig, DEFAULT_ENGAGEMENT_CONFIG } from "@/lib/engagement/config";
import type { EngagementEvent } from "@/lib/engagement/types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 15, 14, 0, 0); // 2026-07-15T14:00:00Z

const cfg = (over: Partial<typeof DEFAULT_ENGAGEMENT_CONFIG> = {}) => ({
  responseThresholdMs: 15 * MIN,
  runCapMs: 30 * MIN,
  tailCreditMs: 0,
  ...over,
});

describe("classifier", () => {
  it("accepts ordinary typed prose", () => {
    expect(isHumanPrompt("merge it")).toBe(true);
    expect(isHumanPrompt("push and open both PRs")).toBe(true);
  });

  it("accepts slash commands and bash input — a person typed those", () => {
    expect(isHumanPrompt("<command-message>pr-resolve</command-message>")).toBe(true);
    expect(isHumanPrompt("<bash-input>npm install</bash-input>")).toBe(true);
  });

  it("rejects machine-tagged output blocks", () => {
    expect(isHumanPrompt("<bash-stdout>added 412 packages</bash-stdout>")).toBe(false);
    expect(isHumanPrompt("<task-notification>\n<task-id>abc</task-id>")).toBe(false);
    expect(isHumanPrompt("<local-command-stdout>ok</local-command-stdout>")).toBe(false);
    expect(isHumanPrompt("<system-reminder>be careful</system-reminder>")).toBe(false);
  });

  it("rejects templated synthetic prose observed in the corpus", () => {
    expect(isHumanPrompt("This session is being continued from a previous conversation that ran out of context")).toBe(false);
    expect(isHumanPrompt("Another Claude session sent a message: <teammate>hi</teammate>")).toBe(false);
    expect(isHumanPrompt("Apply maximum non-destructive compression. Run through the transcript")).toBe(false);
    expect(isHumanPrompt("/compact")).toBe(false);
    expect(isHumanPrompt("You are summarizing a Claude Code session for the archive")).toBe(false);
    expect(isHumanPrompt("You are the staff historian for HistoricSiteMarkers, writing entries")).toBe(false);
  });

  it("does not swallow ordinary sentences that merely start with 'You are'", () => {
    // The scripted-prompt rule is anchored and requires a role noun; an
    // instruction to the model must survive it.
    expect(isHumanPrompt("You are right, revert that change")).toBe(true);
    expect(isHumanPrompt("You are missing the point about the cache")).toBe(true);
  });

  it("treats empty and blank previews as machine", () => {
    expect(isHumanPrompt("")).toBe(false);
    expect(isHumanPrompt("   \n ")).toBe(false);
    expect(isHumanPrompt(null)).toBe(false);
    expect(isHumanPrompt(undefined)).toBe(false);
  });

  it("flags interrupts as presence, not as prompts", () => {
    expect(isHumanInterrupt("[Request interrupted by user]")).toBe(true);
    expect(isHumanInterrupt("merge it")).toBe(false);
    // still 'human' for block purposes — pressing escape proves someone is there
    expect(isHumanPrompt("[Request interrupted by user]")).toBe(true);
  });
});

describe("buildAttendedBlocks — credit formula", () => {
  const ev = (offsets: [number, "human" | "agent"][]): EngagementEvent[] =>
    offsets.map(([m, kind]) => ({ ts: T0 + m * MIN, kind }));

  it("keeps a block open across a long agent run when the human replies promptly", () => {
    // The case a naive 'gap between my messages' rule gets wrong: 40 minutes
    // pass, but the agent was working and the human answered in 1 minute.
    const events = ev([[0, "human"], [1, "agent"], [40, "agent"], [41, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg({ runCapMs: 120 * MIN }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].promptCount).toBe(2);
    // agentBusy = lastAgent(40) - prevHuman(0) = 40; quiet = 1; under the cap
    // the pair telescopes to the whole 41-minute gap.
    expect(blockHours(blocks) * 60).toBeCloseTo(41, 5);
  });

  it("credits an attended gap with a single assistant turn in it", () => {
    // Regression guard: measuring agentBusy first-to-last agent event returns
    // zero here and silently dropped 19 supervised minutes.
    const events = ev([[0, "human"], [20, "agent"], [21, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg());
    expect(blockHours(blocks) * 60).toBeCloseTo(21, 5);
  });

  it("credits only the tail when the human walked away", () => {
    // Conservative policy: agent work inside an unattended gap earns nothing.
    // Prompt at 0, agent finishes at 2, human returns at 45 (> 15 threshold).
    const events = ev([[0, "human"], [1, "agent"], [2, "agent"], [45, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg({ tailCreditMs: 3 * MIN }));
    expect(blocks).toHaveLength(2);
    // two bare prompts, 3 min tail each — not the 2 min the agent ran
    expect(blockHours(blocks) * 60).toBeCloseTo(6, 5);
  });

  it("caps credit for one agent run — the pinned branch", () => {
    // Regression guard for the 10.5h divergence between two candidate models:
    // credit min(agentBusy, cap) and KEEP the block open, rather than crediting
    // a flat cap and splitting.
    const events = ev([[0, "human"], [1, "agent"], [61, "agent"], [62, "human"]]);
    const capped = buildAttendedBlocks(events, cfg({ runCapMs: 30 * MIN }));
    expect(capped).toHaveLength(1);
    // credit = min(60, 30) + quiet 1 = 31
    expect(blockHours(capped) * 60).toBeCloseTo(31, 5);

    const uncapped = buildAttendedBlocks(events, cfg({ runCapMs: 120 * MIN }));
    expect(blockHours(uncapped) * 60).toBeCloseTo(62, 5);
  });

  it("never credits more wall clock than actually elapsed", () => {
    // Two back-to-back 40-minute runs, each answered in a minute. Both are
    // attended, both are capped at 30, so 82 minutes of wall clock books 62.
    const events = ev([[0, "human"], [40, "agent"], [41, "human"], [81, "agent"], [82, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg({ runCapMs: 30 * MIN }));
    expect(blocks).toHaveLength(1);
    expect(blockHours(blocks) * 60).toBeCloseTo(62, 5);
    expect(blockHours(blocks) * 60).toBeLessThan(82);
  });

  it("adds tail credit once per block, not per prompt", () => {
    const events = ev([[0, "human"], [1, "agent"], [2, "human"], [3, "agent"], [4, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg({ tailCreditMs: 3 * MIN }));
    expect(blocks).toHaveLength(1);
    expect(blockHours(blocks) * 60).toBeCloseTo(4 + 3, 5);
  });

  it("returns no blocks when nobody spoke", () => {
    expect(buildAttendedBlocks(ev([[0, "agent"], [5, "agent"]]), cfg())).toEqual([]);
    expect(buildAttendedBlocks([], cfg())).toEqual([]);
  });

  it("tolerates out-of-order input", () => {
    const scrambled = ev([[41, "human"], [0, "human"], [40, "agent"], [1, "agent"]]);
    const blocks = buildAttendedBlocks(scrambled, cfg({ runCapMs: 120 * MIN }));
    expect(blocks).toHaveLength(1);
    expect(blockHours(blocks) * 60).toBeCloseTo(41, 5);
  });

  it("excludes presence-only events from the prompt count but not the block", () => {
    const events = ev([[0, "human"], [1, "agent"], [2, "human"]]);
    const blocks = buildAttendedBlocks(events, cfg(), (i) => i === 2);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].promptCount).toBe(1);
    expect(blockHours(blocks) * 60).toBeCloseTo(2, 5);
  });
});

describe("mergeIntervals", () => {
  it("collapses overlapping and touching spans", () => {
    expect(mergeIntervals([
      { start: 0, end: 10 }, { start: 5, end: 20 }, { start: 20, end: 25 }, { start: 40, end: 50 },
    ])).toEqual([{ start: 0, end: 25 }, { start: 40, end: 50 }]);
  });

  it("drops zero and negative length spans", () => {
    expect(mergeIntervals([{ start: 5, end: 5 }, { start: 9, end: 3 }])).toEqual([]);
  });
});

describe("local day math", () => {
  it("buckets by local date, not UTC date", () => {
    // 2026-07-16T02:00Z is still 2026-07-15 in New York.
    const ts = Date.UTC(2026, 6, 16, 2, 0, 0);
    expect(localDayKey(ts, "UTC")).toBe("2026-07-16");
    expect(localDayKey(ts, "America/New_York")).toBe("2026-07-15");
  });

  it("finds the next local midnight", () => {
    const ts = Date.UTC(2026, 6, 15, 20, 0, 0); // 16:00 EDT
    const next = startOfNextLocalDay(ts, "America/New_York");
    expect(localDayKey(next, "America/New_York")).toBe("2026-07-16");
    expect(localDayKey(next - 1, "America/New_York")).toBe("2026-07-15");
  });

  it("always advances, even across a DST spring-forward", () => {
    const ts = Date.UTC(2026, 2, 8, 3, 0, 0); // US DST transition weekend
    expect(startOfNextLocalDay(ts, "America/New_York")).toBeGreaterThan(ts);
  });
});

describe("allocateConcurrent", () => {
  const block = (startMin: number, endMin: number) => ({
    start: T0 + startMin * MIN, end: T0 + endMin * MIN, promptCount: 1,
  });

  it("splits concurrent time so allocations sum to the union", () => {
    const map = new Map([
      ["alpha", [block(0, 60)]],
      ["beta", [block(30, 90)]],
    ]);
    const res = allocateConcurrent(map, "UTC");
    // union is 0..90 = 1.5h; overlap 30..60 is split evenly
    expect(res.unionHours).toBeCloseTo(1.5, 6);
    expect(res.byProject.get("alpha")).toBeCloseTo(0.5 + 0.25, 6);
    expect(res.byProject.get("beta")).toBeCloseTo(0.25 + 0.5, 6);
    const sum = [...res.byProject.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(res.unionHours, 6);
  });

  it("keeps the sum-to-union invariant with three-way concurrency", () => {
    const map = new Map([
      ["a", [block(0, 60)]], ["b", [block(0, 60)]], ["c", [block(0, 60)]],
    ]);
    const res = allocateConcurrent(map, "UTC");
    expect(res.unionHours).toBeCloseTo(1, 6);
    for (const k of ["a", "b", "c"]) expect(res.byProject.get(k)).toBeCloseTo(1 / 3, 6);
  });

  it("attributes each slice to the local day it happened in", () => {
    // 23:30 -> 00:30 local New York, spanning midnight.
    const start = Date.UTC(2026, 6, 16, 3, 30); // 23:30 EDT on the 15th
    const map = new Map([["alpha", [{ start, end: start + 60 * MIN, promptCount: 1 }]]]);
    const res = allocateConcurrent(map, "America/New_York");
    expect(res.byDay.get("2026-07-15")?.get("alpha")).toBeCloseTo(0.5, 6);
    expect(res.byDay.get("2026-07-16")?.get("alpha")).toBeCloseTo(0.5, 6);
  });

  it("honours an alternative concurrency policy", () => {
    const map = new Map([["alpha", [block(0, 60)]], ["beta", [block(0, 60)]]]);
    const rank = new Map([["alpha", 10], ["beta", 1]]);
    const res = allocateConcurrent(map, "UTC", primaryWinsPolicy(rank));
    expect(res.byProject.get("alpha")).toBeCloseTo(1, 6);
    expect(res.byProject.get("beta") ?? 0).toBeCloseTo(0, 6);
    expect(res.unionHours).toBeCloseTo(1, 6);
  });

  it("returns an empty result for no blocks", () => {
    const res = allocateConcurrent(new Map(), "UTC", equalSplitPolicy);
    expect(res.unionHours).toBe(0);
    expect(res.byProject.size).toBe(0);
  });
});

describe("resolveEngagementConfig", () => {
  it("falls back to measured defaults", () => {
    expect(resolveEngagementConfig(null)).toEqual(DEFAULT_ENGAGEMENT_CONFIG);
    expect(resolveEngagementConfig({ responseThresholdMs: "nonsense" }).responseThresholdMs)
      .toBe(DEFAULT_ENGAGEMENT_CONFIG.responseThresholdMs);
  });

  it("clamps hostile values instead of billing a whole weekend", () => {
    expect(resolveEngagementConfig({ responseThresholdMs: 99 * 3600_000 }).responseThresholdMs)
      .toBe(120 * MIN);
    expect(resolveEngagementConfig({ tailCreditMs: -5000 }).tailCreditMs).toBe(0);
  });
});

describe("buildEngagementReport", () => {
  const row = (
    project: string, minute: number, role: "user" | "assistant",
    text: string | null, toolResult: string | null = null,
  ): EngagementTurnRow => ({
    projectDirName: project,
    projectSlug: project.replace(/^C--dev-/, "dev-"),
    ts: new Date(T0 + minute * MIN).toISOString(),
    role,
    textPreview: text,
    toolResultPreview: toolResult,
  });

  it("produces per-project and per-day rows that reconcile", () => {
    const rows: EngagementTurnRow[] = [
      row("C--dev-client", 0, "user", "build the dashboard"),
      row("C--dev-client", 1, "assistant", "on it"),
      row("C--dev-client", 2, "user", null, "tool output here"),
      row("C--dev-client", 20, "assistant", "done"),
      row("C--dev-client", 21, "user", "ship it"),
    ];
    const report = buildEngagementReport(rows, {
      period: "30d", timeZone: "UTC", config: cfg({ tailCreditMs: 3 * MIN }),
    });
    expect(report.byProject).toHaveLength(1);
    expect(report.byProject[0].promptCount).toBe(2);
    // credit = min(busy 20, cap 30) + quiet 1 = 21, + 3 tail
    expect(report.totalHours).toBeCloseTo(24 / 60, 2);
    expect(report.overlapHours).toBe(0);
    const daySum = report.byDay.reduce((s, d) => s + d.totalHours, 0);
    expect(daySum).toBeCloseTo(report.totalHours, 1);
  });

  it("reports overlap when two projects were worked at once", () => {
    const rows: EngagementTurnRow[] = [
      // The assistant lands at 29 so the 1-minute reply is inside the
      // threshold — an attended 30-minute block on both projects at once.
      row("C--dev-alpha", 0, "user", "start"),
      row("C--dev-alpha", 29, "assistant", "ok"),
      row("C--dev-alpha", 30, "user", "continue"),
      row("C--dev-beta", 0, "user", "start"),
      row("C--dev-beta", 29, "assistant", "ok"),
      row("C--dev-beta", 30, "user", "continue"),
    ];
    const report = buildEngagementReport(rows, {
      period: "30d", timeZone: "UTC", config: cfg(),
    });
    expect(report.rawHours).toBeGreaterThan(report.totalHours);
    expect(report.overlapHours).toBeCloseTo(report.rawHours - report.totalHours, 2);
    const allocSum = report.byProject.reduce((s, p) => s + p.allocatedHours, 0);
    expect(allocSum).toBeCloseTo(report.totalHours, 1);
  });

  it("ignores turns that are not human, yielding no billable time", () => {
    const rows: EngagementTurnRow[] = [
      row("C--dev-cron", 0, "user", "You are the staff historian for HistoricSiteMarkers"),
      row("C--dev-cron", 1, "assistant", "writing"),
      row("C--dev-cron", 40, "assistant", "done"),
    ];
    const report = buildEngagementReport(rows, { period: "30d", timeZone: "UTC", config: cfg() });
    expect(report.totalHours).toBe(0);
    expect(report.byProject).toHaveLength(0);
  });

  it("drops rows with unparseable timestamps rather than poisoning the walk", () => {
    const bad: EngagementTurnRow = { ...row("C--dev-x", 0, "user", "hi"), ts: "not-a-date" };
    const report = buildEngagementReport([bad], { period: "30d", timeZone: "UTC", config: cfg() });
    expect(report.totalHours).toBe(0);
  });
});
