import type { SessionSummary } from "@/lib/types";

export type ScatterPreset = "complexity-cost" | "context-pressure" | "reliability";

export interface SessionScatterPoint {
  sessionId: string;
  /**
   * The three measurements below stay optional all the way to the plot.
   *
   * They used to be coerced with `?? 0` here, which put every unmeasured
   * session on an axis as though it had been measured at zero. On the
   * reference index that is 2,974 of 5,028 sessions (59.1%) with no
   * `maxContextFill` — a majority of the "Context Pressure" cloud sitting on
   * the floor, each with a tooltip stating `0% fill` as a fact. Worse on
   * "Reliability", where the coercion reads as a 0% first-pass success rate:
   * the worst score on the chart, awarded for not having been measured.
   *
   * Same principle as A6's hook durations — `undefined` means *not measured*,
   * and the honest rendering is to leave the point out and say how many were
   * left out, not to invent a coordinate for it.
   */
  durationMs?: number;
  costEstimate: number;
  messageCount: number;
  toolCount: number;
  oneShotRate?: number;
  maxContextFill?: number;
  hasCompactionLoop: boolean;
  hasToolFailureStreak: boolean;
  status: SessionSummary["status"];
}

export function projectScatter(s: SessionSummary): SessionScatterPoint {
  return {
    sessionId: s.sessionId,
    durationMs: s.durationMs,
    costEstimate: s.costEstimate,
    messageCount: s.messageCount,
    toolCount: Object.values(s.toolUsage).reduce((sum, c) => sum + c, 0),
    oneShotRate: s.oneShotRate,
    maxContextFill: s.maxContextFill,
    // Genuinely booleans: absence means the quality pass found no loop/streak,
    // not that it failed to look. Unlike the measurements above, `false` is the
    // correct reading of absent here.
    hasCompactionLoop: s.hasCompactionLoop ?? false,
    hasToolFailureStreak: s.hasToolFailureStreak ?? false,
    status: s.status,
  };
}

/**
 * The measurement each preset puts on an axis, and therefore requires. A point
 * missing it cannot be placed, so it is excluded rather than placed at zero.
 */
const PLOTTED_MEASURE: Record<
  ScatterPreset,
  { key: "durationMs" | "maxContextFill" | "oneShotRate"; label: string }
> = {
  // Note this is the *x* measurement for complexity-cost and the *y* for the
  // other two, so the exclusion notice cannot just reuse `yLabel`.
  "complexity-cost": { key: "durationMs", label: "duration" },
  "context-pressure": { key: "maxContextFill", label: "peak context fill" },
  reliability: { key: "oneShotRate", label: "1-shot rate" },
};

/** Points this preset can actually place, plus how many it could not. */
export function selectPlottable(
  points: SessionScatterPoint[],
  preset: ScatterPreset
): { plotted: SessionScatterPoint[]; excluded: number } {
  const { key } = PLOTTED_MEASURE[preset];
  const plotted = points.filter((p) => typeof p[key] === "number");
  return { plotted, excluded: points.length - plotted.length };
}

interface PreparedScatter {
  x: number[];
  y: number[];
  xLabel: string;
  yLabel: string;
  size: number[];
  color: string[];
  tooltips: string[];
  /**
   * Sessions omitted because they carry no value for the plotted measurement.
   * The chart states this next to the axes — a silently shorter cloud reads as
   * "you have fewer sessions", which is a different and equally wrong claim.
   */
  excluded: number;
  /** Human name of the measurement the excluded points lack, for the notice. */
  excludedMeasureLabel: string;
  /**
   * The points these arrays describe, in the same order.
   *
   * Returned rather than left to the caller because the renderer walks the
   * point list and the coordinate arrays together (`points.map((p, i) => …
   * x[i]`). Filtering one without the other silently pairs each dot with a
   * different session's id — a click would open the wrong session. Handing
   * back both from the one filter makes that misalignment unrepresentable.
   */
  plotted: SessionScatterPoint[];
}

function safeLog(v: number): number {
  return v > 0 ? Math.log10(v) : 0;
}

function normalizeSize(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map((v) => Math.max(4, (v / max) * 20));
}

// All returned arrays share the same length as the *plotted* subset, which is
// `points` minus the ones with no value for this preset's measurement.
export function prepareScatterData(
  points: SessionScatterPoint[],
  preset: ScatterPreset
): PreparedScatter {
  const { plotted, excluded } = selectPlottable(points, preset);
  const excludedMeasureLabel = PLOTTED_MEASURE[preset].label;

  switch (preset) {
    case "complexity-cost": {
      return {
        excluded,
        plotted,
        excludedMeasureLabel,
        // Non-null assertions are sound: `selectPlottable` kept only the points
        // whose plotted measurement is a number, per PLOTTED_MEASURE.
        x: plotted.map((p) => safeLog(p.durationMs!)),
        y: plotted.map((p) => p.costEstimate),
        xLabel: "Duration (log ms)",
        yLabel: "Cost (USD)",
        size: normalizeSize(plotted.map((p) => p.toolCount)),
        color: plotted.map((p) =>
          p.status === "working"
            ? "var(--status-active-text)"
            : p.status === "needs_attention"
            ? "var(--status-error-text)"
            : "var(--text-muted)"
        ),
        tooltips: plotted.map(
          (p) =>
            `${p.sessionId.slice(0, 8)} · ${(p.durationMs! / 60000).toFixed(1)}min · $${p.costEstimate.toFixed(4)} · ${p.toolCount} tools`
        ),
      };
    }
    case "context-pressure":
    case "reliability": {
      const x = plotted.map((p) => p.messageCount);
      const size = normalizeSize(plotted.map((p) => p.costEstimate * 1000));
      if (preset === "context-pressure") {
        return {
          excluded,
        plotted,
        excludedMeasureLabel,
          x,
          y: plotted.map((p) => p.maxContextFill!),
          xLabel: "Messages",
          yLabel: "Peak context fill",
          size,
          color: plotted.map((p) => p.hasCompactionLoop ? "var(--status-error-text)" : "var(--info)"),
          tooltips: plotted.map(
            (p) =>
              `${p.sessionId.slice(0, 8)} · ${p.messageCount} msgs · ${(p.maxContextFill! * 100).toFixed(0)}% fill${p.hasCompactionLoop ? " · compacted" : ""}`
          ),
        };
      }
      return {
        excluded,
        plotted,
        excludedMeasureLabel,
        x,
        y: plotted.map((p) => p.oneShotRate!),
        xLabel: "Messages",
        yLabel: "1-shot rate",
        size,
        color: plotted.map((p) => p.hasToolFailureStreak ? "var(--status-error-text)" : "var(--accent)"),
        tooltips: plotted.map(
          (p) =>
            `${p.sessionId.slice(0, 8)} · ${p.messageCount} msgs · ${(p.oneShotRate! * 100).toFixed(0)}% 1-shot${p.hasToolFailureStreak ? " · tool failures" : ""}`
        ),
      };
    }
  }
}
