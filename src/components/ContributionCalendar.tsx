"use client";

import { useState } from "react";
import type { ContributionCell } from "@/lib/usage/types";

interface Props {
  cells: ContributionCell[];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function computeTiers(cells: ContributionCell[]): number[] {
  const nonZero = cells.map((c) => c.turns).filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [0, 0, 0, 0, 0];
  const q = (p: number) => nonZero[Math.floor(p * (nonZero.length - 1))];
  return [q(0.2), q(0.4), q(0.6), q(0.8), nonZero[nonZero.length - 1]];
}

function tierColor(turns: number, tiers: number[]): string {
  if (turns === 0) return "var(--bg-elevated)";
  if (turns <= tiers[0]) return "color-mix(in oklch, var(--accent) 30%, transparent)";
  if (turns <= tiers[1]) return "color-mix(in oklch, var(--accent) 50%, transparent)";
  if (turns <= tiers[2]) return "color-mix(in oklch, var(--accent) 65%, transparent)";
  if (turns <= tiers[3]) return "color-mix(in oklch, var(--accent) 80%, transparent)";
  return "var(--accent)";
}

export function ContributionCalendar({ cells }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);

  const hasData = cells.some((c) => c.turns > 0);
  if (!hasData) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "24px 0", textAlign: "center" }}>
        Not enough activity yet
      </div>
    );
  }

  const tiers = computeTiers(cells);
  const cellSize = 10;
  const gap = 2;
  const step = cellSize + gap;
  const weeks = cells.length > 0 ? (cells[cells.length - 1].weekIndex + 1) : 52;
  const labelH = 16;

  // Determine month labels: show label at the first cell of a new month
  const monthLabels: { weekIndex: number; label: string }[] = [];
  let lastMonth = -1;
  for (const cell of cells) {
    if (cell.dayOfWeek === 0) {
      const month = new Date(cell.date).getMonth();
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
      {!hasData && (
        <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "6px" }}>
          No activity recorded yet
        </div>
      )}
      <svg width={svgW} height={svgH} style={{ overflow: "visible", width: "100%", height: "auto" }} viewBox={`0 0 ${svgW} ${svgH}`}>
        {/* Month labels */}
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
        {/* Cells */}
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
      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
            background: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "6px",
            padding: "5px 9px",
            fontSize: "11px",
            color: "var(--text-primary)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 9999,
          }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
