"use client";

import { useEffect, useState } from "react";
import type { QuotaData, QuotaWindow } from "@/lib/quota";
import type { ScheduleMode } from "@/lib/types";
import {
  computeProjectedUtilization,
  formatCountdown,
  scheduleLabel,
  utilColor,
  type WindowKey,
} from "@/lib/quotaProjection";

const VIEW_W = 500;
const BAR_H = 12;
const BAR_X = 0;
const ROW_H = 62;

function UtilRow({
  label,
  window,
  windowKey,
  scheduleMode,
  nowMs,
  y,
}: {
  label: string;
  window: QuotaWindow;
  windowKey: WindowKey;
  scheduleMode: ScheduleMode;
  nowMs: number;
  y: number;
}) {
  const pct = Math.round(window.utilization * 100);
  const color = utilColor(window.utilization);
  const now = nowMs / 1000;
  const secsLeft = Math.max(0, window.reset - now);
  const countdown = formatCountdown(secsLeft);
  const projected = computeProjectedUtilization(window, windowKey, scheduleMode, nowMs);
  const projPct = projected !== null ? Math.round(projected * 100) : null;
  const barFill = Math.min(window.utilization, 1) * VIEW_W;

  return (
    <g>
      <text x={BAR_X} y={y} fill="var(--text-secondary)" fontSize={11} fontFamily="var(--font-body)">
        {label}
      </text>

      <rect x={BAR_X} y={y + 6} width={VIEW_W} height={BAR_H} rx={BAR_H / 2} fill="var(--border-subtle, #333)" />
      <rect x={BAR_X} y={y + 6} width={barFill} height={BAR_H} rx={BAR_H / 2} fill={color} />

      <text
        x={BAR_X + VIEW_W - 2}
        y={y + BAR_H}
        fill={color}
        fontSize={11}
        fontFamily="var(--font-mono)"
        textAnchor="end"
      >
        {pct}%
      </text>

      <text x={BAR_X} y={y + BAR_H + 16} fill="var(--text-muted)" fontSize={10} fontFamily="var(--font-mono)">
        Resets in {countdown}
      </text>

      {projPct !== null && (
        <text
          x={BAR_X + VIEW_W - 2}
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
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

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
          nowMs={nowMs}
          y={4}
        />
        <UtilRow
          label="7-day rolling window"
          window={data.windows["7d"]}
          windowKey="7d"
          scheduleMode={scheduleMode}
          nowMs={nowMs}
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
