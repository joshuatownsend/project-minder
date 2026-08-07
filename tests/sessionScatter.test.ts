import { describe, it, expect } from "vitest";
import { projectScatter, prepareScatterData, selectPlottable } from "@/lib/usage/sessionScatter";
import type { SessionSummary } from "@/lib/types";
import type { SessionScatterPoint } from "@/lib/usage/sessionScatter";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "abc123",
    projectPath: "/dev/test",
    projectSlug: "test",
    projectName: "Test",
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheCreateTokens: 100,
    costEstimate: 0.05,
    toolUsage: { Read: 3, Edit: 2 },
    modelsUsed: ["claude-sonnet-4-5"],
    subagentCount: 0,
    errorCount: 0,
    isActive: false,
    status: "idle",
    skillsUsed: {},
    durationMs: 60000,
    oneShotRate: 0.75,
    maxContextFill: 0.3,
    hasCompactionLoop: false,
    hasToolFailureStreak: false,
    ...overrides,
  } as SessionSummary;
}

describe("projectScatter", () => {
  it("returns a stable shape from a session summary", () => {
    const point = projectScatter(makeSession());
    expect(point).toMatchObject({
      sessionId: "abc123",
      durationMs: 60000,
      costEstimate: 0.05,
      messageCount: 10,
      toolCount: 5,
      oneShotRate: 0.75,
      maxContextFill: 0.3,
      hasCompactionLoop: false,
      hasToolFailureStreak: false,
      status: "idle",
    });
  });

  it("sums toolUsage values into toolCount", () => {
    const point = projectScatter(makeSession({ toolUsage: { Read: 10, Bash: 5, Edit: 3 } }));
    expect(point.toolCount).toBe(18);
  });

  // This test used to assert the opposite — that the three optional fields were
  // "safely defaulted" to 0. That was not a safe default, it was the defect:
  // `?? 0` put every unmeasured session on an axis as though measured at zero.
  // On the reference index, 2,974 of 5,028 sessions (59.1%) carry no
  // `maxContextFill`, so the majority of the Context Pressure cloud sat on the
  // floor with tooltips stating "0% fill" as a fact; on Reliability the same
  // coercion read as a 0% first-pass rate, the worst score on the chart,
  // awarded for not having been measured.
  //
  // The test was written from the same assumption as the code, so it ratified
  // the bug rather than catching it — the failure mode this repo has hit before
  // (the `user-invocable` default, PR #383).
  it("carries absent measurements through as undefined, never 0", () => {
    const point = projectScatter(makeSession({ durationMs: undefined, oneShotRate: undefined, maxContextFill: undefined }));
    expect(point.durationMs).toBeUndefined();
    expect(point.oneShotRate).toBeUndefined();
    expect(point.maxContextFill).toBeUndefined();
  });

  it("preserves measurements that are genuinely zero", () => {
    // The distinction the fix turns on: a real 0% one-shot rate is a
    // measurement and must survive, while absence must not become one.
    const point = projectScatter(makeSession({ durationMs: 0, oneShotRate: 0, maxContextFill: 0 }));
    expect(point.durationMs).toBe(0);
    expect(point.oneShotRate).toBe(0);
    expect(point.maxContextFill).toBe(0);
  });

  it("still reads absent quality booleans as false", () => {
    // Unlike the measurements, absence here means the quality pass looked and
    // found nothing — `false` is the correct reading, not "unknown".
    const point = projectScatter(makeSession({ hasCompactionLoop: undefined, hasToolFailureStreak: undefined }));
    expect(point.hasCompactionLoop).toBe(false);
    expect(point.hasToolFailureStreak).toBe(false);
  });
});

describe("prepareScatterData", () => {
  const points: SessionScatterPoint[] = [
    {
      sessionId: "abc123",
      durationMs: 60000,
      costEstimate: 0.05,
      messageCount: 10,
      toolCount: 5,
      oneShotRate: 0.75,
      maxContextFill: 0.3,
      hasCompactionLoop: false,
      hasToolFailureStreak: false,
      status: "idle",
    },
    {
      sessionId: "def456",
      durationMs: 0,
      costEstimate: 0,
      messageCount: 0,
      toolCount: 0,
      oneShotRate: 0,
      maxContextFill: 0,
      hasCompactionLoop: true,
      hasToolFailureStreak: true,
      status: "working",
    },
  ];

  it("returns matched-length arrays for complexity-cost", () => {
    const d = prepareScatterData(points, "complexity-cost");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("returns matched-length arrays for context-pressure", () => {
    const d = prepareScatterData(points, "context-pressure");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("returns matched-length arrays for reliability", () => {
    const d = prepareScatterData(points, "reliability");
    expect(d.x).toHaveLength(points.length);
    expect(d.y).toHaveLength(points.length);
    expect(d.size).toHaveLength(points.length);
    expect(d.color).toHaveLength(points.length);
    expect(d.tooltips).toHaveLength(points.length);
  });

  it("is log-scale safe on zeros (complexity-cost)", () => {
    const zeroPoints = points.map((p) => ({ ...p, durationMs: 0 }));
    const d = prepareScatterData(zeroPoints, "complexity-cost");
    for (const v of d.x) {
      expect(isFinite(v)).toBe(true);
      expect(isNaN(v)).toBe(false);
    }
  });

  it("is log-scale safe on zero costEstimate (context-pressure)", () => {
    const d = prepareScatterData(points, "context-pressure");
    for (const v of d.size) {
      expect(isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(4);
    }
  });

  it("colors compactionLoop sessions differently in context-pressure", () => {
    const d = prepareScatterData(points, "context-pressure");
    // points[1] has hasCompactionLoop: true
    expect(d.color[1]).toContain("error");
    expect(d.color[0]).toContain("info");
  });

  it("colors toolFailureStreak sessions differently in reliability", () => {
    const d = prepareScatterData(points, "reliability");
    // points[1] has hasToolFailureStreak: true
    expect(d.color[1]).toContain("error");
    expect(d.color[0]).not.toContain("error");
  });

  it("handles empty points array without error", () => {
    const d = prepareScatterData([], "complexity-cost");
    expect(d.x).toHaveLength(0);
  });
});

// ── Exclusion of unmeasured points ────────────────────────────────────────────

function point(over: Partial<SessionScatterPoint> = {}): SessionScatterPoint {
  return {
    sessionId: "s-0000000000",
    costEstimate: 1,
    messageCount: 10,
    toolCount: 2,
    hasCompactionLoop: false,
    hasToolFailureStreak: false,
    status: "idle",
    ...over,
  } as SessionScatterPoint;
}

describe("selectPlottable", () => {
  it("keeps only points carrying the measurement each preset plots", () => {
    for (const [preset, measured] of [
      ["complexity-cost", { durationMs: 500 }],
      ["context-pressure", { maxContextFill: 0.4 }],
      ["reliability", { oneShotRate: 0.9 }],
    ] as const) {
      const { plotted, excluded } = selectPlottable([point(measured), point(), point(measured)], preset);
      expect(plotted).toHaveLength(2);
      expect(excluded).toBe(1);
    }
  });

  it("keeps a genuine zero rather than treating it as missing", () => {
    // `typeof x === "number"`, not truthiness: a session measured at 0% context
    // fill belongs on the chart at 0, and dropping it would understate exactly
    // what the preset exists to show.
    const { plotted, excluded } = selectPlottable([point({ maxContextFill: 0 })], "context-pressure");
    expect(plotted).toHaveLength(1);
    expect(excluded).toBe(0);
  });

  it("gates on each preset's own measurement, not a shared one", () => {
    const p = [point({ durationMs: 100 })];
    expect(selectPlottable(p, "complexity-cost").excluded).toBe(0);
    expect(selectPlottable(p, "context-pressure").excluded).toBe(1);
    expect(selectPlottable(p, "reliability").excluded).toBe(1);
  });
});

describe("prepareScatterData — exclusion reporting", () => {
  it("returns arrays aligned with the plotted points, not the input", () => {
    // The alignment that matters: the renderer walks `plotted` and indexes the
    // coordinate arrays by the same i. If the lengths diverge, every dot after
    // the first exclusion carries a different session's id and clicking one
    // opens the wrong session.
    const points = [
      point({ sessionId: "aaaaaaaa-keep", maxContextFill: 0.2 }),
      point({ sessionId: "bbbbbbbb-drop" }),
      point({ sessionId: "cccccccc-keep", maxContextFill: 0.8 }),
    ];
    const d = prepareScatterData(points, "context-pressure");

    expect(d.excluded).toBe(1);
    for (const arr of [d.x, d.y, d.size, d.color, d.tooltips]) {
      expect(arr).toHaveLength(d.plotted.length);
    }
    expect(d.plotted.map((p) => p.sessionId)).toEqual(["aaaaaaaa-keep", "cccccccc-keep"]);
    expect(d.tooltips[0]).toContain("aaaaaaaa");
    expect(d.tooltips[1]).toContain("cccccccc");
    expect(d.y).toEqual([0.2, 0.8]);
  });

  it("names the measurement that caused the exclusion, per preset", () => {
    // complexity-cost excludes on its X measurement, so the notice cannot reuse
    // `yLabel` ("Cost (USD)") — it would blame the wrong axis.
    expect(prepareScatterData([point()], "complexity-cost").excludedMeasureLabel).toBe("duration");
    expect(prepareScatterData([point()], "context-pressure").excludedMeasureLabel).toBe("peak context fill");
    expect(prepareScatterData([point()], "reliability").excludedMeasureLabel).toBe("1-shot rate");
  });

  it("reports zero exclusions when every point is measured", () => {
    const d = prepareScatterData([point({ oneShotRate: 1 })], "reliability");
    expect(d.excluded).toBe(0);
    expect(d.plotted).toHaveLength(1);
  });
});

describe("prepareScatterData — nothing plottable", () => {
  // Reachable with a non-empty session list: a corpus predating a measurement,
  // or one where OTEL was never enabled, filters out entirely. The renderer
  // then took Math.min/max of empty arrays — Infinity / -Infinity — and handed
  // D3 an unrenderable scale domain (both bots, review of #403).
  it("returns empty arrays rather than throwing when no point carries the measurement", () => {
    const points = [point(), point(), point()];
    for (const preset of ["complexity-cost", "context-pressure", "reliability"] as const) {
      const d = prepareScatterData(points, preset);
      expect(d.plotted).toHaveLength(0);
      expect(d.excluded).toBe(3);
      for (const arr of [d.x, d.y, d.size, d.color, d.tooltips]) {
        expect(arr).toHaveLength(0);
      }
    }
  });

  it("still names the missing measurement so the empty state can be specific", () => {
    // The empty state says which measurement is absent rather than "no data" —
    // the other two presets may well have plenty.
    expect(prepareScatterData([point()], "reliability").excludedMeasureLabel).toBe("1-shot rate");
  });

  it("distinguishes 'nothing plottable' from 'no sessions at all'", () => {
    const noSessions = prepareScatterData([], "reliability");
    const noneMeasured = prepareScatterData([point(), point()], "reliability");
    expect(noSessions.excluded).toBe(0);      // nothing was dropped; there was nothing
    expect(noneMeasured.excluded).toBe(2);    // two sessions exist and were dropped
    expect(noSessions.plotted).toHaveLength(0);
    expect(noneMeasured.plotted).toHaveLength(0);
  });
});
