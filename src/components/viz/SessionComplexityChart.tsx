"use client";

import { useState, useMemo } from "react";
import * as d3 from "d3";
import { D3Container, Axes } from "./D3Container";
import { prepareScatterData } from "@/lib/usage/sessionScatter";
import type { SessionScatterPoint, ScatterPreset } from "@/lib/usage/sessionScatter";

interface Props {
  sessions: SessionScatterPoint[];
}

const PRESETS: { key: ScatterPreset; label: string }[] = [
  { key: "complexity-cost", label: "Complexity vs Cost" },
  { key: "context-pressure", label: "Context Pressure" },
  { key: "reliability", label: "Reliability" },
];

export function SessionComplexityChart({ sessions }: Props) {
  const [preset, setPreset] = useState<ScatterPreset>("complexity-cost");
  const [logX, setLogX] = useState(false);
  const [logY, setLogY] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const prepared = useMemo(() => prepareScatterData(sessions, preset), [sessions, preset]);

  if (sessions.length === 0) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        No session data available.
      </div>
    );
  }

  const margin = { top: 20, right: 16, bottom: 48, left: 56 };

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            style={{
              padding: "3px 10px",
              fontSize: "0.7rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border-default)",
              background: preset === p.key ? "var(--accent)" : "var(--bg-surface)",
              color: preset === p.key ? "var(--bg-base)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {p.label}
          </button>
        ))}
        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "8px" }}>
          <input
            type="checkbox"
            checked={logX}
            onChange={(e) => setLogX(e.target.checked)}
            style={{ marginRight: "4px", accentColor: "var(--accent)" }}
          />
          log x
        </label>
        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
          <input
            type="checkbox"
            checked={logY}
            onChange={(e) => setLogY(e.target.checked)}
            style={{ marginRight: "4px", accentColor: "var(--accent)" }}
          />
          log y
        </label>
      </div>

      <D3Container height={360} margin={margin}>
        {({ width, height, showTooltip, hideTooltip }) => (
          <ScatterInner
            prepared={prepared}
            sessions={sessions}
            width={width}
            height={height}
            logX={logX}
            logY={logY}
            hovered={hovered}
            setHovered={setHovered}
            showTooltip={showTooltip}
            hideTooltip={hideTooltip}
          />
        )}
      </D3Container>

    </div>
  );
}

function ScatterInner({
  prepared,
  sessions,
  width,
  height,
  logX,
  logY,
  hovered,
  setHovered,
  showTooltip,
  hideTooltip,
}: {
  prepared: ReturnType<typeof prepareScatterData>;
  sessions: SessionScatterPoint[];
  width: number;
  height: number;
  logX: boolean;
  logY: boolean;
  hovered: number | null;
  setHovered: (i: number | null) => void;
  showTooltip: (x: number, y: number, content: string) => void;
  hideTooltip: () => void;
}) {
  const xs = prepared.x;
  const ys = prepared.y;

  const xMin = Math.min(...xs.filter(isFinite));
  const xMax = Math.max(...xs.filter(isFinite));
  const yMin = Math.min(...ys.filter(isFinite));
  const yMax = Math.max(...ys.filter(isFinite));

  const safeXDomain: [number, number] = [
    Math.max(xMin === xMax ? 0 : xMin, logX ? 0.001 : -Infinity),
    xMax === xMin ? xMax + 1 : xMax,
  ];
  const safeYDomain: [number, number] = [
    Math.max(yMin === yMax ? 0 : yMin, logY ? 0.001 : -Infinity),
    yMax === yMin ? yMax + 1 : yMax,
  ];

  const xScale = logX
    ? d3.scaleLog().domain(safeXDomain).range([0, width]).clamp(true)
    : d3.scaleLinear().domain(safeXDomain).range([0, width]).nice();

  const yScale = logY
    ? d3.scaleLog().domain(safeYDomain).range([height, 0]).clamp(true)
    : d3.scaleLinear().domain(safeYDomain).range([height, 0]).nice();

  return (
    <g>
      <Axes
        xScale={xScale as any}
        yScale={yScale as any}
        width={width}
        height={height}
        xLabel={prepared.xLabel}
        yLabel={prepared.yLabel}
        tickCountX={5}
        tickCountY={5}
      />
      {sessions.map((s, i) => {
        const cx = xScale(xs[i]);
        const cy = yScale(ys[i]);
        if (!isFinite(cx) || !isFinite(cy)) return null;
        const r = prepared.size[i] / 2;
        const isHovered = hovered === i;

        return (
          <circle
            key={s.sessionId}
            cx={cx}
            cy={cy}
            r={isHovered ? r * 1.4 : r}
            fill={prepared.color[i]}
            fillOpacity={isHovered ? 0.9 : 0.55}
            stroke={isHovered ? "var(--text-primary)" : "none"}
            strokeWidth={1}
            style={{ cursor: "pointer" }}
            onClick={() => window.location.assign(`/sessions/${s.sessionId}`)}
            onMouseEnter={(e) => {
              setHovered(i);
              showTooltip(e.clientX, e.clientY - 12, prepared.tooltips[i]);
            }}
            onMouseLeave={() => {
              setHovered(null);
              hideTooltip();
            }}
          />
        );
      })}
    </g>
  );
}
