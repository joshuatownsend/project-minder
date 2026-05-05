"use client";

import { useState } from "react";
import type { ActivityBucket } from "@/lib/usage/types";

interface Props {
  byHourOfDay: ActivityBucket[];
}

function computeTiers(buckets: ActivityBucket[]): number[] {
  const nonZero = buckets.map((b) => b.turns).filter((v) => v > 0).sort((a, b) => a - b);
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

export function HourlyDistributionChart({ byHourOfDay }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);

  const hasData = byHourOfDay.some((b) => b.turns > 0);
  if (!hasData) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "24px 0", textAlign: "center" }}>
        Not enough activity yet
      </div>
    );
  }

  const tiers = computeTiers(byHourOfDay);
  const maxTurns = Math.max(...byHourOfDay.map((b) => b.turns));
  const svgH = 80;
  const barW = 10;
  const gap = 2;
  const totalW = byHourOfDay.length * (barW + gap) - gap;

  return (
    <div style={{ position: "relative", userSelect: "none" }}>
      <svg width={totalW} height={svgH + 20} style={{ overflow: "visible", width: "100%", height: "auto" }} viewBox={`0 0 ${totalW} ${svgH + 20}`}>
        {byHourOfDay.map((bucket, h) => {
          const x = h * (barW + gap);
          const barH = maxTurns > 0 ? (bucket.turns / maxTurns) * svgH : 0;
          const y = svgH - barH;
          const showLabel = h === 0 || h === 6 || h === 12 || h === 18;
          return (
            <g key={h}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH || 1}
                fill={tierColor(bucket.turns, tiers)}
                rx={1}
                style={{ cursor: "default" }}
                onMouseEnter={(e) => {
                  const rect = (e.target as SVGRectElement).getBoundingClientRect();
                  setTooltip({
                    x: rect.left + rect.width / 2,
                    y: rect.top - 8,
                    content: `${String(h).padStart(2, "0")}:00 — ${bucket.turns} turns · $${bucket.cost.toFixed(4)}`,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={svgH + 14}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--text-muted)"
                >
                  {h}
                </text>
              )}
            </g>
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
