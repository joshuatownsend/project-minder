import { describe, it, expect } from "vitest";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity } from "@/lib/usage/activityBuckets";
import type { UsageTurn } from "@/lib/usage/types";

/**
 * #522 — every ranking is ordered by a TOTAL comparator.
 *
 * The rankings sorted on one descending key and stopped, so entries with an
 * equal measure fell back to map insertion order — which comes from the corpus
 * sweep, and used to depend on which parse finished first. Two runs over an
 * unchanged tree could order tied rows differently.
 *
 * These tests feed DELIBERATE TIES, which is the only way to exercise a
 * tie-break: a fixture whose measures all differ passes whether or not the
 * comparator has a second key. Confirmed by mutation — replacing the tie-break
 * with `return 0` left every other test in the suite green.
 *
 * The tie-break is the entry's own name, so the expected order is alphabetical
 * among equals.
 */

function turn(over: Partial<UsageTurn> = {}): UsageTurn {
  return {
    sessionId: "s1",
    projectSlug: "app",
    projectDirName: "-home-me-dev-app",
    timestamp: "2026-03-01T10:00:00.000Z",
    role: "assistant",
    model: "claude-opus-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    toolCalls: [],
    ...over,
  } as UsageTurn;
}

describe("#522 — tied rankings are ordered by name, not by arrival", () => {
  it("orders tied models alphabetically", async () => {
    // Identical token counts on every model, so cost ties exactly. Inserted in
    // REVERSE alphabetical order, so insertion order and the expected order
    // disagree — otherwise the test passes on a stable sort with no tie-break.
    const turns = ["zeta-model", "mid-model", "alpha-model"].map((model, i) =>
      turn({ model, sessionId: `s${i}`, inputTokens: 100 })
    );

    const report = await aggregateUsage(turns, "all", emptyActivity());
    const tied = report.byModel.filter((m) => m.cost === report.byModel[0].cost);
    expect(tied.length).toBeGreaterThan(1);
    expect(report.byModel.map((m) => m.model)).toEqual([
      "alpha-model",
      "mid-model",
      "zeta-model",
    ]);
  });

  it("orders tied tools alphabetically — the one that decides MEMBERSHIP", async () => {
    // `topTools` slices, so a tie straddling the boundary meant a tool appeared
    // in one run's report and not the next. That makes this the consequential
    // case rather than a cosmetic one.
    const names = ["ZebraTool", "MiddleTool", "AlphaTool"];
    const turns = names.map((name, i) =>
      turn({
        sessionId: `s${i}`,
        inputTokens: 10,
        toolCalls: [{ name }] as UsageTurn["toolCalls"],
      })
    );

    const report = await aggregateUsage(turns, "all", emptyActivity());
    const counts = report.topTools.map(([, n]) => n);
    // One call each: a three-way tie.
    expect(new Set(counts).size).toBe(1);
    expect(report.topTools.map(([name]) => name)).toEqual([
      "AlphaTool",
      "MiddleTool",
      "ZebraTool",
    ]);
  });

  it("orders tied projects by slug", async () => {
    const turns = ["zeta", "mid", "alpha"].map((slug, i) =>
      turn({
        sessionId: `s${i}`,
        projectSlug: slug,
        projectDirName: `-home-me-dev-${slug}`,
        inputTokens: 100,
      } as Partial<UsageTurn>)
    );

    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.byProject.map((p) => p.projectSlug)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("is invariant to the order the turns arrive in", async () => {
    // The property behind all three: the report must be a function of the
    // corpus, not of the sweep's timing. Same turns, reversed.
    const names = ["b-model", "a-model", "c-model"];
    const forward = names.map((model, i) => turn({ model, sessionId: `s${i}`, inputTokens: 100 }));
    const backward = [...forward].reverse();

    const a = await aggregateUsage(forward, "all", emptyActivity());
    const b = await aggregateUsage(backward, "all", emptyActivity());

    expect(b.byModel.map((m) => m.model)).toEqual(a.byModel.map((m) => m.model));
    expect(a.byModel.map((m) => m.model)).toEqual(["a-model", "b-model", "c-model"]);
  });
});
