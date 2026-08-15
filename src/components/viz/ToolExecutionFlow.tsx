"use client";

import { useState, useMemo } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import type { ToolTransition, ToolSelfLoop } from "@/lib/usage/types";
import { buildSankeyFlow, type FlowEdge } from "@/lib/usage/sankeyFlow";

interface Props {
  transitions: ToolTransition[];
  selfLoops: ToolSelfLoop[];
}

const NODE_WIDTH = 18;
const NODE_PADDING = 10;
const HEIGHT = 320;
const MARGIN = { top: 16, right: 160, bottom: 16, left: 16 };

// Graph preparation lives in `@/lib/usage/sankeyFlow` — it is pure logic and
// gets its own tests there. This file is responsible for drawing only.

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

  const {
    nodes: sankeyNodes,
    links: sankeyLinks,
    droppedEdges,
    failed,
  } = useMemo(() => {
    const empty = { nodes: [] as any[], links: [] as any[], droppedEdges: [] as FlowEdge[], failed: false };
    if (transitions.length === 0) return empty;

    const { nodes, links, droppedEdges } = buildSankeyFlow(transitions, topN);
    if (links.length === 0) return { ...empty, droppedEdges };

    const layout = sankey<{ name: string }, { source: number; target: number; value: number }>()
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .nodeAlign(sankeyJustify)
      .extent([[0, 0], [innerWidth, innerHeight]]);

    try {
      return { ...layout({ nodes: nodes as any, links: links as any }), droppedEdges, failed: false };
    } catch {
      // Second line of defence, and the one that matters most. This runs
      // during render, so anything d3-sankey throws here takes the entire
      // /usage route down and the browser replaces it with its own error
      // page — the chart does not simply go blank (#443).
      //
      // `buildSankeyFlow` should have made a `circular link` impossible, but
      // d3-sankey throws on other conditions too (`missing: <node>`), and a
      // dead page is far too steep a price for a chart that cannot lay out.
      // Degrade to a message instead.
      return { ...empty, droppedEdges, failed: true };
    }
  }, [transitions, topN, innerWidth, innerHeight]);

  if (transitions.length === 0) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        No tool transition data yet. Use Claude Code to generate activity.
      </div>
    );
  }

  // Layout refused the graph, or nothing survived the top-N cut. Say so in
  // the chart's own empty-state styling rather than rendering an empty SVG
  // that reads as "no activity".
  if (failed || sankeyLinks.length === 0) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        {failed
          ? "This flow couldn't be laid out. The rest of the page is unaffected."
          : "No transitions between the top tools at this threshold — try raising it."}
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

        {/* A Sankey needs an acyclic graph, but tool flows are cyclic by
            nature (Edit → Bash → Edit). Weakest edges are dropped to make one
            — disclosed here because a Sankey missing edges silently reads as
            a complete picture of the flow. */}
        {droppedEdges.length > 0 && (
          <span
            title={
              `A Sankey diagram cannot show cycles, and tool flows contain them ` +
              `(Edit → Bash → Edit). The lowest-volume transition in each cycle is ` +
              `hidden so the rest can be drawn:\n\n` +
              droppedEdges
                .map((e) => `${e.from} → ${e.to} (${e.count.toLocaleString()})`)
                .join("\n")
            }
            style={{
              fontSize: "0.68rem",
              color: "var(--text-muted)",
              fontFamily: "var(--font-body)",
              borderBottom: "1px dotted var(--border-subtle)",
              cursor: "help",
            }}
          >
            {droppedEdges.length} cyclic {droppedEdges.length === 1 ? "transition" : "transitions"} hidden
          </span>
        )}
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
