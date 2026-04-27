"use client";

import { useState } from "react";

interface ActivitySparklineProps {
  data: number[]; // 14 daily counts, oldest→newest
  width?: number;
  height?: number;
}

interface Tooltip {
  left: number;
  top: number;
  label: string;
}

export function ActivitySparkline({ data, width = 70, height = 20 }: ActivitySparklineProps) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const bars = 14;
  const gap = 1;
  const barW = (width - gap * (bars - 1)) / bars;
  const max = Math.max(...data, 1);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", overflow: "visible" }}
      >
        {data.map((count, i) => {
          const barHeight = count > 0 ? Math.max((count / max) * (height - 2) + 2, 3) : 1;
          const x = i * (barW + gap);
          const y = height - barHeight;
          const opacity = count === 0 ? 0.12 : 0.4 + (count / max) * 0.6;

          const d = new Date(today);
          d.setUTCDate(d.getUTCDate() - (13 - i));
          const label = `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${count} session${count !== 1 ? "s" : ""}`;

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={barHeight}
              rx={1}
              fill="var(--info)"
              opacity={opacity}
              style={{ cursor: "default" }}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                setTooltip({
                  left: rect.left + rect.width / 2,
                  top: rect.top,
                  label,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        })}
      </svg>
      {tooltip && (
        <span
          style={{
            position: "fixed",
            top: tooltip.top - 28,
            left: tooltip.left,
            pointerEvents: "none",
            zIndex: 9999,
            background: "var(--card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            padding: "2px 6px",
            fontSize: "0.65rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
            transform: "translateX(-50%)",
          }}
        >
          {tooltip.label}
        </span>
      )}
    </span>
  );
}
