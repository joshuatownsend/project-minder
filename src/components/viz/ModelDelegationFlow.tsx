"use client";

import { useEffect, useState } from "react";
import * as d3 from "d3";
import { D3Container } from "./D3Container";
import { MODEL_FAMILY_COLORS } from "./agentPalette";
import { modelFamily, shortModelName } from "@/lib/usage/modelHelpers";
import type { DelegationReport, DelegationEdge } from "@/lib/usage/modelDelegation";

interface Props {
  sessionId: string;
}

const NODE_WIDTH = 120;
const NODE_HEIGHT_MAX = 60;
const NODE_HEIGHT_MIN = 20;

export function ModelDelegationFlow({ sessionId }: Props) {
  const [data, setData] = useState<DelegationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/model-delegation`)
      .then((r) => r.ok ? r.json() : r.json().then((e: { error: string }) => Promise.reject(e.error)))
      .then((d: DelegationReport) => { setData(d); setLoading(false); })
      .catch((e: string) => { setError(String(e)); setLoading(false); });
  }, [sessionId]);

  if (loading) {
    return <div style={{ height: "200px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />;
  }

  if (error) {
    return <p style={{ fontSize: "0.8rem", color: "var(--status-error-text)" }}>{error}</p>;
  }

  if (!data || data.edges.length === 0) {
    return <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No model delegation data — session has no cross-model subagent calls.</p>;
  }

  return <FlowInner data={data} />;
}

function FlowInner({ data }: { data: DelegationReport }) {
  const { edges, parentModels, childModels } = data;

  const maxTokens = Math.max(...edges.map((e) => e.tokens), 1);
  const maxCount = Math.max(...edges.map((e) => e.count), 1);

  // Per-model total tokens (for node height)
  const parentTotals = new Map<string, number>();
  const childTotals = new Map<string, number>();
  for (const e of edges) {
    parentTotals.set(e.from, (parentTotals.get(e.from) ?? 0) + e.tokens);
    childTotals.set(e.to, (childTotals.get(e.to) ?? 0) + e.tokens);
  }
  const maxParentTokens = Math.max(...[...parentTotals.values()], 1);
  const maxChildTokens = Math.max(...[...childTotals.values()], 1);

  const nodeHeight = (tokens: number, maxT: number) =>
    NODE_HEIGHT_MIN + ((tokens / maxT) * (NODE_HEIGHT_MAX - NODE_HEIGHT_MIN));

  const strokeWidth = d3.scaleLinear().domain([1, maxCount]).range([1, 6]).clamp(true);
  const strokeOpacity = (tokens: number) => 0.3 + (tokens / maxTokens) * 0.65;

  // Vertical layout: evenly spaced
  const vSpacing = (nodes: string[], totalH: number) => {
    if (nodes.length === 0) return new Map<string, number>();
    const step = totalH / nodes.length;
    return new Map(nodes.map((n, i) => [n, step * i + step / 2]));
  };

  const TOTAL_HEIGHT = 300;
  const parentYMap = vSpacing(parentModels, TOTAL_HEIGHT);
  const childYMap = vSpacing(childModels, TOTAL_HEIGHT);

  return (
    <D3Container height={TOTAL_HEIGHT + 40} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
      {({ width, showTooltip, hideTooltip }) => {
        const leftX = 0;
        const rightX = width - NODE_WIDTH;
        const midX = width / 2;

        return (
          <g>
            {/* Bezier edges */}
            {edges.map((edge: DelegationEdge, i: number) => {
              const fromY = parentYMap.get(edge.from) ?? 0;
              const toY = childYMap.get(edge.to) ?? 0;
              const color = MODEL_FAMILY_COLORS[modelFamily(edge.from)] ?? "var(--text-muted)";
              return (
                <path
                  key={i}
                  d={`M${leftX + NODE_WIDTH},${fromY} C${midX},${fromY} ${midX},${toY} ${rightX},${toY}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth(edge.count)}
                  strokeOpacity={strokeOpacity(edge.tokens)}
                  style={{ cursor: "default" }}
                  onMouseEnter={(e) => {
                    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
                    showTooltip(r.left + r.width / 2, r.top - 8,
                      `${shortModelName(edge.from)} → ${shortModelName(edge.to)} · ${edge.count} delegations · ${(edge.tokens / 1000).toFixed(1)}K tokens`);
                  }}
                  onMouseLeave={hideTooltip}
                />
              );
            })}

            {/* Parent model nodes */}
            {parentModels.map((m) => {
              const y = parentYMap.get(m) ?? 0;
              const h = nodeHeight(parentTotals.get(m) ?? 0, maxParentTokens);
              const color = MODEL_FAMILY_COLORS[modelFamily(m)] ?? "var(--text-muted)";
              return (
                <g key={`parent-${m}`}>
                  <rect x={leftX} y={y - h / 2} width={NODE_WIDTH} height={h} rx={4} fill={color} opacity={0.9} />
                  <text x={leftX + NODE_WIDTH / 2} y={y} textAnchor="middle" dominantBaseline="middle"
                    fontSize="0.65rem" fontFamily="var(--font-mono)" fill="var(--bg-surface)">
                    {shortModelName(m)}
                  </text>
                </g>
              );
            })}

            {/* Child model nodes */}
            {childModels.map((m) => {
              const y = childYMap.get(m) ?? 0;
              const h = nodeHeight(childTotals.get(m) ?? 0, maxChildTokens);
              const color = MODEL_FAMILY_COLORS[modelFamily(m)] ?? "var(--text-muted)";
              return (
                <g key={`child-${m}`}>
                  <rect x={rightX} y={y - h / 2} width={NODE_WIDTH} height={h} rx={4} fill={color} opacity={0.9} />
                  <text x={rightX + NODE_WIDTH / 2} y={y} textAnchor="middle" dominantBaseline="middle"
                    fontSize="0.65rem" fontFamily="var(--font-mono)" fill="var(--bg-surface)">
                    {shortModelName(m)}
                  </text>
                </g>
              );
            })}

            {/* Column labels */}
            <text x={leftX + NODE_WIDTH / 2} y={TOTAL_HEIGHT + 16} textAnchor="middle" fontSize="0.62rem" fontFamily="var(--font-mono)" fill="var(--text-muted)">Primary model</text>
            <text x={rightX + NODE_WIDTH / 2} y={TOTAL_HEIGHT + 16} textAnchor="middle" fontSize="0.62rem" fontFamily="var(--font-mono)" fill="var(--text-muted)">Subagent model</text>
          </g>
        );
      }}
    </D3Container>
  );
}
