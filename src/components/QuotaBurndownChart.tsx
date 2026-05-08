"use client";

import type { QuotaData, QuotaWindow } from "@/lib/quota";
import type { ScheduleMode } from "@/lib/types";

const VIEW_W = 500;
const BAR_H = 12;
const BAR_X = 0;
const BAR_W = VIEW_W;
const ROW_H = 62;

function scheduleLabel(mode: ScheduleMode): string {
  switch (mode) {
    case "weekdays":    return "Weekdays (Mon–Fri)";
    case "vibe-coder":  return "Vibe coder (~70% of hours)";
    case "24x7":        return "24 × 7 (always on)";
    case "custom":      return "Custom";
  }
}

// Fraction of 7d window that is "active" given schedule mode.
function scheduleActiveFraction(mode: ScheduleMode): number {
  switch (mode) {
    case "weekdays":   return 5 / 7;
    case "vibe-coder": return 0.7;
    case "custom":
    case "24x7":       return 1;
  }
}

function formatCountdown(secsLeft: number): string {
  if (secsLeft <= 0) return "now";
  const h = Math.floor(secsLeft / 3600);
  const m = Math.floor((secsLeft % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function windowDurationSecs(key: "5h" | "7d"): number {
  return key === "5h" ? 5 * 3600 : 7 * 24 * 3600;
}

function computeProjected(
  window: QuotaWindow,
  key: "5h" | "7d",
  scheduleMode: ScheduleMode
): number | null {
  const now = Date.now() / 1000;
  const secsLeft = window.reset - now;
  const totalSecs = windowDurationSecs(key);
  const elapsedSecs = totalSecs - secsLeft;
  if (elapsedSecs <= 0) return null;
  const elapsedFrac = elapsedSecs / totalSecs;
  const activeFrac = key === "7d" ? scheduleActiveFraction(scheduleMode) : 1;
  const projected = (window.utilization / elapsedFrac) * activeFrac;
  return Math.min(projected, 2); // cap at 200% for display
}

function utilColor(utilization: number): string {
  if (utilization >= 0.9) return "var(--status-error-text, #f87171)";
  if (utilization >= 0.7) return "var(--warning, #fb923c)";
  return "var(--status-active-text, #4ade80)";
}

function UtilRow({
  label,
  window,
  windowKey,
  scheduleMode,
  y,
}: {
  label: string;
  window: QuotaWindow;
  windowKey: "5h" | "7d";
  scheduleMode: ScheduleMode;
  y: number;
}) {
  const pct = Math.round(window.utilization * 100);
  const color = utilColor(window.utilization);
  const now = Date.now() / 1000;
  const secsLeft = Math.max(0, window.reset - now);
  const countdown = formatCountdown(secsLeft);
  const projected = computeProjected(window, windowKey, scheduleMode);
  const projPct = projected !== null ? Math.round(projected * 100) : null;
  const barFill = Math.min(window.utilization, 1) * BAR_W;

  return (
    <g>
      {/* Section label */}
      <text x={BAR_X} y={y} fill="var(--text-secondary)" fontSize={11} fontFamily="var(--font-body)">
        {label}
      </text>

      {/* Progress bar track */}
      <rect x={BAR_X} y={y + 6} width={BAR_W} height={BAR_H} rx={BAR_H / 2} fill="var(--border-subtle, #333)" />
      {/* Progress bar fill */}
      <rect x={BAR_X} y={y + 6} width={barFill} height={BAR_H} rx={BAR_H / 2} fill={color} />

      {/* Pct label right of bar */}
      <text
        x={BAR_X + BAR_W - 2}
        y={y + BAR_H}
        fill={color}
        fontSize={11}
        fontFamily="var(--font-mono)"
        textAnchor="end"
      >
        {pct}%
      </text>

      {/* Reset countdown */}
      <text x={BAR_X} y={y + BAR_H + 16} fill="var(--text-muted)" fontSize={10} fontFamily="var(--font-mono)">
        Resets in {countdown}
      </text>

      {/* Projection */}
      {projPct !== null && (
        <text
          x={BAR_X + BAR_W - 2}
          y={y + BAR_H + 16}
          fill={projPct >= 90 ? "var(--status-error-text, #f87171)" : projPct >= 70 ? "var(--warning, #fb923c)" : "var(--text-muted)"}
          fontSize={10}
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {projPct >= 100 ? `⚠ ~${projPct}% projected` : `~${projPct}% projected`}
        </text>
      )}
    </g>
  );
}

interface Props {
  data: QuotaData;
  scheduleMode: ScheduleMode;
}

export function QuotaBurndownChart({ data, scheduleMode }: Props) {
  const VIEW_H = ROW_H * 2 + 10;

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
        <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          {data.subscriptionType} · {data.rateLimitTier}
        </span>
        <span style={{
          fontSize: "0.72rem",
          fontFamily: "var(--font-mono)",
          color: data.overallStatus === "allowed" ? "var(--status-active-text)" : "var(--status-error-text)",
        }}>
          ● {data.overallStatus}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        height={VIEW_H * 0.6}
        style={{ display: "block", overflow: "visible" }}
      >
        <UtilRow
          label="5-hour rolling window"
          window={data.windows["5h"]}
          windowKey="5h"
          scheduleMode={scheduleMode}
          y={4}
        />
        <UtilRow
          label="7-day rolling window"
          window={data.windows["7d"]}
          windowKey="7d"
          scheduleMode={scheduleMode}
          y={4 + ROW_H}
        />
      </svg>

      <div style={{
        fontSize: "0.68rem",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        marginTop: "6px",
      }}>
        Schedule: {scheduleLabel(scheduleMode)} · Projection assumes linear usage rate within window.
        Cached at {new Date(data.cachedAt).toLocaleTimeString()}.
      </div>
    </div>
  );
}
