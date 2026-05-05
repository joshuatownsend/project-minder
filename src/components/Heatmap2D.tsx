"use client";

import { useState } from "react";
import type { ActivityBucket } from "@/lib/usage/types";
import { computeActivityTiers, tierColor } from "@/lib/usage/chartTiers";
import { ChartTooltip } from "./ui/ChartTooltip";

interface Props {
  byHourDay: ActivityBucket[][];
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap2D({ byHourDay }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);

  const hasData = byHourDay.some((row) => row.some((b) => b.turns > 0));
  if (!hasData) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "24px 0", textAlign: "center" }}>
        Not enough activity yet
      </div>
    );
  }

  const tiers = computeActivityTiers(byHourDay.flat().map((b) => b.turns));
  const cellW = 10;
  const cellH = 10;
  const gap = 2;
  const labelW = 30;
  const labelH = 16;
  const svgW = labelW + 24 * (cellW + gap) - gap;
  const svgH = labelH + 7 * (cellH + gap) - gap;

  return (
    <div style={{ position: "relative", userSelect: "none" }}>
      <svg width={svgW} height={svgH} style={{ overflow: "visible", width: "100%", height: "auto" }} viewBox={`0 0 ${svgW} ${svgH}`}>
        {[0, 6, 12, 18].map((h) => (
          <text
            key={h}
            x={labelW + h * (cellW + gap)}
            y={labelH - 4}
            fontSize="8"
            fill="var(--text-muted)"
          >
            {h}
          </text>
        ))}
        {byHourDay.map((hourRow, dow) => (
          <g key={dow}>
            <text
              x={labelW - 4}
              y={labelH + dow * (cellH + gap) + cellH / 2 + 3}
              textAnchor="end"
              fontSize="8"
              fill="var(--text-muted)"
            >
              {DOW_LABELS[dow]}
            </text>
            {hourRow.map((bucket, h) => {
              const x = labelW + h * (cellW + gap);
              const y = labelH + dow * (cellH + gap);
              return (
                <rect
                  key={h}
                  x={x}
                  y={y}
                  width={cellW}
                  height={cellH}
                  fill={tierColor(bucket.turns, tiers)}
                  rx={1}
                  style={{ cursor: "default" }}
                  onMouseEnter={(e) => {
                    const r = (e.target as SVGRectElement).getBoundingClientRect();
                    setTooltip({
                      x: r.left + r.width / 2,
                      y: r.top - 8,
                      content: `${DOW_LABELS[dow]} ${String(h).padStart(2, "0")}:00 — ${bucket.turns} turns · $${bucket.cost.toFixed(4)}`,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })}
          </g>
        ))}
      </svg>
      {tooltip && <ChartTooltip x={tooltip.x} y={tooltip.y} content={tooltip.content} />}
    </div>
  );
}
