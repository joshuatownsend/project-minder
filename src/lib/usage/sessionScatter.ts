import type { SessionSummary } from "@/lib/types";

export type ScatterPreset = "complexity-cost" | "context-pressure" | "reliability";

export interface SessionScatterPoint {
  sessionId: string;
  durationMs: number;
  costEstimate: number;
  messageCount: number;
  toolCount: number;
  oneShotRate: number;
  maxContextFill: number;
  hasCompactionLoop: boolean;
  hasToolFailureStreak: boolean;
  status: SessionSummary["status"];
}

export function projectScatter(s: SessionSummary): SessionScatterPoint {
  return {
    sessionId: s.sessionId,
    durationMs: s.durationMs ?? 0,
    costEstimate: s.costEstimate,
    messageCount: s.messageCount,
    toolCount: Object.values(s.toolUsage).reduce((sum, c) => sum + c, 0),
    oneShotRate: s.oneShotRate ?? 0,
    maxContextFill: s.maxContextFill ?? 0,
    hasCompactionLoop: s.hasCompactionLoop ?? false,
    hasToolFailureStreak: s.hasToolFailureStreak ?? false,
    status: s.status,
  };
}

interface PreparedScatter {
  x: number[];
  y: number[];
  xLabel: string;
  yLabel: string;
  size: number[];
  color: string[];
  tooltips: string[];
}

function safeLog(v: number): number {
  return v > 0 ? Math.log10(v) : 0;
}

function normalizeSize(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map((v) => Math.max(4, (v / max) * 20));
}

/**
 * Project scatter points into plottable arrays for a given preset.
 * All returned arrays share the same length as `points`.
 */
export function prepareScatterData(
  points: SessionScatterPoint[],
  preset: ScatterPreset
): PreparedScatter {
  switch (preset) {
    case "complexity-cost": {
      return {
        x: points.map((p) => safeLog(p.durationMs)),
        y: points.map((p) => p.costEstimate),
        xLabel: "Duration (log ms)",
        yLabel: "Cost (USD)",
        size: normalizeSize(points.map((p) => p.toolCount)),
        color: points.map((p) =>
          p.status === "working"
            ? "var(--status-active-text)"
            : p.status === "needs_attention"
            ? "var(--status-error-text)"
            : "var(--text-muted)"
        ),
        tooltips: points.map(
          (p) =>
            `${p.sessionId.slice(0, 8)} · ${(p.durationMs / 60000).toFixed(1)}min · $${p.costEstimate.toFixed(4)} · ${p.toolCount} tools`
        ),
      };
    }
    case "context-pressure": {
      return {
        x: points.map((p) => p.messageCount),
        y: points.map((p) => p.maxContextFill),
        xLabel: "Messages",
        yLabel: "Peak context fill",
        size: normalizeSize(points.map((p) => p.costEstimate * 1000)),
        color: points.map((p) =>
          p.hasCompactionLoop ? "var(--status-error-text)" : "var(--info)"
        ),
        tooltips: points.map(
          (p) =>
            `${p.sessionId.slice(0, 8)} · ${p.messageCount} msgs · ${(p.maxContextFill * 100).toFixed(0)}% fill${p.hasCompactionLoop ? " · compacted" : ""}`
        ),
      };
    }
    case "reliability": {
      return {
        x: points.map((p) => p.messageCount),
        y: points.map((p) => p.oneShotRate),
        xLabel: "Messages",
        yLabel: "1-shot rate",
        size: normalizeSize(points.map((p) => p.costEstimate * 1000)),
        color: points.map((p) =>
          p.hasToolFailureStreak ? "var(--status-error-text)" : "var(--accent)"
        ),
        tooltips: points.map(
          (p) =>
            `${p.sessionId.slice(0, 8)} · ${p.messageCount} msgs · ${(p.oneShotRate * 100).toFixed(0)}% 1-shot${p.hasToolFailureStreak ? " · tool failures" : ""}`
        ),
      };
    }
  }
}
