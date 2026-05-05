"use client";

import { useState } from "react";
import type { ContributionCell } from "@/lib/usage/types";
import { computeActivityTiers, tierColor } from "@/lib/usage/chartTiers";
import { ChartTooltip } from "./ui/ChartTooltip";

interface Props {
  cells: ContributionCell[];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ContributionCalendar({ cells }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);

  const hasData = cells.some((c) => c.turns > 0);
  if (!hasData) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "24px 0", textAlign: "center" }}>
        No activity in the past 52 weeks
      </div>
    );
  }

  const tiers = computeActivityTiers(cells.map((c) => c.turns));
  const cellSize = 10;
  const gap = 2;
  const step = cellSize + gap;
  const weeks = cells[cells.length - 1].weekIndex + 1;
  const labelH = 16;

  const monthLabels: { weekIndex: number; label: string }[] = [];
  let lastMonth = -1;
  for (const cell of cells) {
    if (cell.dayOfWeek === 0) {
      // Parse month directly from YYYY-MM-DD to avoid UTC-midnight boundary errors
      const month = Number(cell.date.slice(5, 7)) - 1;
      if (month !== lastMonth) {
        monthLabels.push({ weekIndex: cell.weekIndex, label: MONTH_NAMES[month] });
        lastMonth = month;
      }
    }
  }

  const svgW = weeks * step - gap;
  const svgH = labelH + 7 * step - gap;

  return (
    <div style={{ position: "relative", userSelect: "none" }}>
      <svg width={svgW} height={svgH} style={{ overflow: "visible", width: "100%", height: "auto" }} viewBox={`0 0 ${svgW} ${svgH}`}>
        {monthLabels.map(({ weekIndex, label }) => (
          <text
            key={`${weekIndex}-${label}`}
            x={weekIndex * step}
            y={labelH - 4}
            fontSize="8"
            fill="var(--text-muted)"
          >
            {label}
          </text>
        ))}
        {cells.map((cell) => {
          const x = cell.weekIndex * step;
          const y = labelH + cell.dayOfWeek * step;
          return (
            <rect
              key={cell.date}
              x={x}
              y={y}
              width={cellSize}
              height={cellSize}
              fill={tierColor(cell.turns, tiers)}
              rx={1}
              style={{ cursor: "default" }}
              onMouseEnter={(e) => {
                const r = (e.target as SVGRectElement).getBoundingClientRect();
                setTooltip({
                  x: r.left + r.width / 2,
                  y: r.top - 8,
                  content: cell.turns > 0
                    ? `${cell.date} — ${cell.turns} turns · $${cell.cost.toFixed(4)}`
                    : `${cell.date} — no activity`,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        })}
      </svg>
      {tooltip && <ChartTooltip x={tooltip.x} y={tooltip.y} content={tooltip.content} />}
    </div>
  );
}
