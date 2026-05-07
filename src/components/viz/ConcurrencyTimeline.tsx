"use client";

import { D3Container } from "./D3Container";
import { AGENT_COLORS } from "./agentPalette";
import { useReportFetch } from "@/hooks/useReportFetch";
import type { TimelineReport, TimelineBar } from "@/lib/usage/concurrencyTimeline";

interface Props {
  sessionId: string;
}

const BAR_HEIGHT = 22;
const BAR_GAP = 6;
const LABEL_WIDTH = 140;

function barColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

export function ConcurrencyTimeline({ sessionId }: Props) {
  const { data, loading, error } = useReportFetch<TimelineReport>(
    `/api/sessions/${sessionId}/concurrency-timeline`
  );

  if (loading) {
    return <div style={{ height: "120px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />;
  }

  if (error) {
    return <p style={{ fontSize: "0.8rem", color: "var(--status-error-text)" }}>{error}</p>;
  }

  if (!data || data.bars.length === 0) {
    return <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No concurrency data — session has no subagents.</p>;
  }

  const totalHeight = data.bars.length * (BAR_HEIGHT + BAR_GAP) + BAR_GAP + 28;

  return (
    <div>
      {data.usedFallback && (
        <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "8px" }}>
          Wall-clock timestamps unavailable — positions estimated from turn order.
        </p>
      )}
      <D3Container
        height={totalHeight}
        margin={{ top: 8, right: 16, bottom: 20, left: LABEL_WIDTH }}
      >
        {({ width, showTooltip, hideTooltip }) => (
          <g>
            {/* Time axis baseline */}
            <line x1={0} y1={totalHeight - 48} x2={width} y2={totalHeight - 48} stroke="var(--border-default)" strokeWidth={1} />

            {data.bars.map((bar: TimelineBar, i: number) => {
              const y = BAR_GAP + i * (BAR_HEIGHT + BAR_GAP);
              const x = (bar.startPct / 100) * width;
              const w = Math.max(2, ((bar.endPct - bar.startPct) / 100) * width);
              const color = bar.nodeId === "__main__" ? "var(--text-secondary)" : barColor(i - 1);
              const label = bar.agentName.length > 18
                ? bar.agentName.slice(0, 17) + "…"
                : bar.agentName;

              return (
                <g key={bar.nodeId}>
                  {/* Label (left side, outside SVG inner area) */}
                  <text
                    x={-8}
                    y={y + BAR_HEIGHT / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize="0.68rem"
                    fontFamily="var(--font-mono)"
                    fill="var(--text-secondary)"
                  >
                    {label}
                  </text>

                  {/* Bar */}
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={BAR_HEIGHT}
                    rx={3}
                    fill={color}
                    opacity={0.8}
                    style={{ cursor: "default" }}
                    onMouseEnter={(e) => {
                      const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
                      showTooltip(
                        rect.left + rect.width / 2,
                        rect.top - 8,
                        `${bar.agentName} · ${bar.turnCount} turns`
                      );
                    }}
                    onMouseLeave={hideTooltip}
                  />

                  {/* Label inside bar if wide enough */}
                  {w > 60 && (
                    <text
                      x={x + w / 2}
                      y={y + BAR_HEIGHT / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize="0.6rem"
                      fontFamily="var(--font-mono)"
                      fill="var(--bg-surface)"
                      style={{ pointerEvents: "none" }}
                    >
                      {bar.turnCount}t
                    </text>
                  )}
                </g>
              );
            })}

            {/* 0% / 100% ticks */}
            <text x={0} y={totalHeight - 36} textAnchor="middle" fontSize="0.58rem" fontFamily="var(--font-mono)" fill="var(--text-muted)">0%</text>
            <text x={width} y={totalHeight - 36} textAnchor="middle" fontSize="0.58rem" fontFamily="var(--font-mono)" fill="var(--text-muted)">100%</text>
          </g>
        )}
      </D3Container>
    </div>
  );
}
