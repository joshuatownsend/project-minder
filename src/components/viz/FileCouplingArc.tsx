"use client";

import { useState, useMemo } from "react";
import * as d3 from "d3";
import { D3Container } from "./D3Container";
import { relPath } from "./relPath";
import type { FileCouplingResult, FilePair } from "@/lib/usage/fileCoupling";

interface Props {
  result: FileCouplingResult;
  maxFiles?: number;
}

export function FileCouplingArc({ result, maxFiles = 25 }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { pairs } = result;

  // Build top-N file set by total pair strength
  const fileScore = useMemo(() => {
    const scores = new Map<string, number>();
    for (const p of pairs) {
      scores.set(p.fileA, (scores.get(p.fileA) ?? 0) + p.coOccurrences);
      scores.set(p.fileB, (scores.get(p.fileB) ?? 0) + p.coOccurrences);
    }
    return scores;
  }, [pairs]);

  const topFiles = useMemo(() => {
    return [...fileScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles)
      .map(([f]) => f);
  }, [fileScore, maxFiles]);

  const topFileSet = useMemo(() => new Set(topFiles), [topFiles]);

  const visiblePairs = useMemo(
    () => pairs.filter((p) => topFileSet.has(p.fileA) && topFileSet.has(p.fileB)),
    [pairs, topFileSet]
  );

  const maxCoOccurrences = Math.max(...visiblePairs.map((p) => p.coOccurrences), 1);
  const strokeWidth = d3.scaleLinear().domain([1, maxCoOccurrences]).range([0.5, 4]).clamp(true);

  if (topFiles.length < 4) {
    return <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Not enough co-edited file pairs to render arc diagram (need ≥ 4 files).</p>;
  }

  return (
    <D3Container
      height={300}
      margin={{ top: 8, right: 16, bottom: 80, left: 16 }}
    >
      {({ width, height, showTooltip, hideTooltip }) => {
        const xScale = d3.scalePoint()
          .domain(topFiles)
          .range([0, width])
          .padding(0.5);

        const xPos = (f: string) => xScale(f) ?? 0;
        const axisY = height - 4;

        return (
          <g>
            {/* Arcs */}
            {visiblePairs.map((p: FilePair) => {
              const xA = xPos(p.fileA);
              const xB = xPos(p.fileB);
              const midX = (xA + xB) / 2;
              const arcH = Math.min(axisY * 0.9, Math.abs(xB - xA) * 0.45);
              const isSelected = selectedFile !== null;
              const isIncident = selectedFile === p.fileA || selectedFile === p.fileB;

              return (
                <path
                  key={`${p.fileA}\0${p.fileB}`}
                  d={`M${xA},${axisY} Q${midX},${axisY - arcH} ${xB},${axisY}`}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={strokeWidth(p.coOccurrences)}
                  strokeOpacity={isSelected ? (isIncident ? p.strength * 0.9 : 0.05) : p.strength * 0.7}
                  style={{ cursor: "default", transition: "stroke-opacity 0.15s" }}
                  onMouseEnter={(e) => {
                    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
                    showTooltip(r.left + r.width / 2, r.top - 8,
                      `${relPath(p.fileA)} ↔ ${relPath(p.fileB)} · ${p.coOccurrences}× · strength ${(p.strength * 100).toFixed(0)}%`);
                  }}
                  onMouseLeave={hideTooltip}
                />
              );
            })}

            {/* Axis baseline */}
            <line x1={0} y1={axisY} x2={width} y2={axisY} stroke="var(--border-default)" strokeWidth={1} />

            {/* File nodes */}
            {topFiles.map((f) => {
              const x = xPos(f);
              const isSelected = selectedFile === f;
              const label = relPath(f);
              const truncated = label.length > 22 ? "…" + label.slice(-21) : label;

              return (
                <g
                  key={f}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedFile(selectedFile === f ? null : f)}
                >
                  <circle
                    cx={x}
                    cy={axisY}
                    r={isSelected ? 5 : 4}
                    fill={isSelected ? "var(--accent)" : "var(--text-secondary)"}
                    opacity={0.9}
                  />
                  <text
                    x={x}
                    y={axisY + 8}
                    textAnchor="end"
                    dominantBaseline="hanging"
                    fontSize="0.6rem"
                    fontFamily="var(--font-mono)"
                    fill={isSelected ? "var(--text-primary)" : "var(--text-muted)"}
                    transform={`rotate(-45, ${x}, ${axisY + 8})`}
                    style={{ pointerEvents: "none" }}
                  >
                    {truncated}
                  </text>
                </g>
              );
            })}
          </g>
        );
      }}
    </D3Container>
  );
}
