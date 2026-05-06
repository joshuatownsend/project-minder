"use client";

import { useState, useMemo } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import type { ToolTransition, ToolSelfLoop } from "@/lib/usage/types";

interface Props {
  transitions: ToolTransition[];
  selfLoops: ToolSelfLoop[];
}

const NODE_WIDTH = 18;
const NODE_PADDING = 10;
const HEIGHT = 320;
const MARGIN = { top: 16, right: 160, bottom: 16, left: 16 };

function buildSankeyData(transitions: ToolTransition[], topN: number) {
  // Determine top-N nodes by total throughput (sum of counts as source + target)
  const throughput = new Map<string, number>();
  for (const t of transitions) {
    throughput.set(t.from, (throughput.get(t.from) ?? 0) + t.count);
    throughput.set(t.to, (throughput.get(t.to) ?? 0) + t.count);
  }
  const topNodes = new Set(
    [...throughput.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name]) => name)
  );

  const filteredTransitions = transitions.filter(
    (t) => topNodes.has(t.from) && topNodes.has(t.to)
  );

  const nodeNames = [...topNodes];
  const nodeIndex = new Map(nodeNames.map((name, i) => [name, i]));

  const nodes = nodeNames.map((name) => ({ name }));
  const links = filteredTransitions.map((t) => ({
    source: nodeIndex.get(t.from)!,
    target: nodeIndex.get(t.to)!,
    value: t.count,
  }));

  return { nodes, links, nodeIndex };
}

export function ToolExecutionFlow({ transitions, selfLoops }: Props) {
  const [topN, setTopN] = useState(12);

  const selfLoopMap = useMemo(
    () => new Map(selfLoops.map((s) => [s.tool, s.count])),
    [selfLoops]
  );

  const totalTransitions = useMemo(
    () => transitions.reduce((s, t) => s + t.count, 0),
    [transitions]
  );

  const svgWidth = 560;
  const innerWidth = svgWidth - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const { nodes: sankeyNodes, links: sankeyLinks } = useMemo(() => {
    if (transitions.length === 0) return { nodes: [], links: [] };
    const { nodes, links } = buildSankeyData(transitions, topN);

    const layout = sankey<{ name: string }, { source: number; target: number; value: number }>()
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .nodeAlign(sankeyJustify)
      .extent([[0, 0], [innerWidth, innerHeight]]);

    return layout({ nodes: nodes as any, links: links as any });
  }, [transitions, topN, innerWidth, innerHeight]);

  if (transitions.length === 0) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        No tool transition data yet. Use Claude Code to generate activity.
      </div>
    );
  }

  const linkPath = sankeyLinkHorizontal();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <label style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
          Top tools:
          <input
            type="range"
            min={5}
            max={30}
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
            style={{ marginLeft: "8px", verticalAlign: "middle", accentColor: "var(--accent)" }}
          />
          <span style={{ marginLeft: "6px", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
            {topN}
          </span>
        </label>
      </div>

      <div style={{ width: "100%", overflowX: "auto" }}>
        <svg width={svgWidth} height={HEIGHT} style={{ display: "block" }}>
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {/* Links */}
            {(sankeyLinks as any[]).map((link, i) => {
              const linkCount = link.value as number;
              const opacity = totalTransitions > 0
                ? Math.max(0.1, Math.min(0.6, linkCount / totalTransitions * 10))
                : 0.2;
              return (
                <path
                  key={i}
                  d={linkPath(link) ?? ""}
                  fill="none"
                  stroke="var(--info)"
                  strokeWidth={Math.max(1, link.width ?? 1)}
                  strokeOpacity={opacity}
                />
              );
            })}

            {/* Nodes */}
            {(sankeyNodes as any[]).map((node, i) => {
              const selfLoopCount = selfLoopMap.get(node.name);
              const nodeColor = "var(--accent)";
              return (
                <g key={i}>
                  <rect
                    x={node.x0}
                    y={node.y0}
                    width={node.x1 - node.x0}
                    height={Math.max(1, node.y1 - node.y0)}
                    fill={nodeColor}
                    fillOpacity={0.8}
                    rx={2}
                  />
                  <text
                    x={node.x1 + 6}
                    y={(node.y0 + node.y1) / 2}
                    dominantBaseline="middle"
                    fontSize="0.62rem"
                    fill="var(--text-secondary)"
                    fontFamily="var(--font-mono)"
                  >
                    {node.name}
                    {selfLoopCount ? ` ×${selfLoopCount}` : ""}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
