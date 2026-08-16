"use client";

import { useState, useMemo } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import type { ToolTransition, ToolSelfLoop } from "@/lib/usage/types";
import { buildSankeyFlow, type FlowEdge } from "@/lib/usage/sankeyFlow";

interface Props {
  transitions: ToolTransition[];
  selfLoops: ToolSelfLoop[];
}

const MAX_TOP_N = 30;
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
    } catch (err) {
      // Logged, not merely swallowed: this branch exists precisely because a
      // layout failure is unexpected, and degrading to a friendly message
      // without a trace would make the next one undiagnosable — the failure
      // would present as "chart missing" with nothing to go on.
      // eslint-disable-next-line no-console
      console.error("[ToolExecutionFlow] d3-sankey layout failed", err);
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

  // Layout refused the graph, or nothing survived the top-N cut. Only the SVG
  // is replaced — the controls stay mounted, see below.
  const emptyReason = failed
    ? "This flow couldn't be laid out. The rest of the page is unaffected."
    : sankeyLinks.length === 0
      ? topN < MAX_TOP_N
        ? "No transitions between the top tools at this threshold — try raising it."
        // At the ceiling there is nothing left to raise, so advising it would
        // be as unfollowable as the unmounted-slider case above. Say what is
        // true instead: these tools genuinely do not hand off to each other.
        : `No transitions between the top ${MAX_TOP_N} tools — they don't hand off to each other.`
      : null;

  const linkPath = sankeyLinkHorizontal();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <label style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
          Top tools:
          <input
            type="range"
            min={5}
            max={MAX_TOP_N}
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
            a complete picture of the flow.

            A real <details> rather than a `title` tooltip: `title` is
            mouse-only — it does not open on keyboard focus in any major
            browser, touch devices have no hover, and screen-reader support is
            inconsistent. That is the exact gap #391 tracks, and putting the
            list behind one would have made the disclosure unreachable for
            precisely the users least able to infer what was dropped.
            <details> is keyboard-, touch- and AT-accessible natively, so this
            instance needs no shared tooltip primitive and does not pre-empt
            the one W6 will build. */}
        {droppedEdges.length > 0 && (
          <details style={{ fontSize: "0.68rem", fontFamily: "var(--font-body)" }}>
            <summary
              style={{
                color: "var(--text-muted)",
                cursor: "pointer",
                listStyle: "revert",
              }}
            >
              {droppedEdges.length} cyclic{" "}
              {droppedEdges.length === 1 ? "transition" : "transitions"} hidden
            </summary>
            <div
              style={{
                marginTop: "6px",
                padding: "8px 10px",
                color: "var(--text-secondary)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                maxWidth: "380px",
              }}
            >
              <p style={{ margin: "0 0 6px" }}>
                A Sankey diagram cannot show cycles, and tool flows contain them
                (Edit → Bash → Edit). The lowest-volume transition in each cycle
                is hidden so the rest can be drawn.
              </p>
              <ul style={{ margin: 0, paddingLeft: "16px", fontFamily: "var(--font-mono)" }}>
                {droppedEdges.map((e) => (
                  <li key={`${e.from}->${e.to}`}>
                    {e.from} → {e.to} ({e.count.toLocaleString()})
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>

      {/* Only the CHART is replaced on an empty/failed layout — the Top-tools
          slider above stays mounted. Returning early here instead stranded the
          user: the message says "try raising it" while the control that raises
          it had just been unmounted, so the advice was impossible to follow
          and the chart could not recover without a remount. Both review bots
          flagged it independently. */}
      {emptyReason ? (
        <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
          {emptyReason}
        </div>
      ) : (
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
      )}
    </div>
  );
}
