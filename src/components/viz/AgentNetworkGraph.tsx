"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import * as d3 from "d3";
import { AGENT_COLORS } from "./agentPalette";
import type { NetworkReport, NetworkNode, NetworkEdge } from "@/lib/usage/agentNetwork";

interface Props {
  sessionId: string;
}

const HEIGHT = 480;
const MARGIN = { top: 20, right: 20, bottom: 20, left: 20 };

export function AgentNetworkGraph({ sessionId }: Props) {
  const [data, setData] = useState<NetworkReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/agent-network`)
      .then((r) => r.ok ? r.json() : r.json().then((e: { error: string }) => Promise.reject(e.error)))
      .then((d: NetworkReport) => { setData(d); setLoading(false); })
      .catch((e: string) => { setError(String(e)); setLoading(false); });
  }, [sessionId]);

  if (loading) {
    return <div style={{ height: `${HEIGHT}px`, background: "var(--bg-elevated)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />;
  }

  if (error) {
    return <p style={{ fontSize: "0.8rem", color: "var(--status-error-text)" }}>{error}</p>;
  }

  if (!data || data.nodes.length === 0) {
    return <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No agent network data — session has no subagents.</p>;
  }

  return <ForceGraph data={data} />;
}

interface SimNode extends NetworkNode, d3.SimulationNodeDatum {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  weight: number;
}

function ForceGraph({ data }: { data: NetworkReport }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);

  const showTooltip = useCallback((x: number, y: number, content: string) => {
    setTooltip({ x, y, content });
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  useEffect(() => {
    const svgEl = svgRef.current;
    const containerEl = containerRef.current;
    if (!svgEl || !containerEl) return;

    const width = containerEl.clientWidth;
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const maxMessages = Math.max(...data.nodes.map((n) => n.messageCount), 1);
    const rScale = d3.scaleSqrt().domain([0, maxMessages]).range([5, 22]).clamp(true);

    // Build mutable copies for force sim
    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = data.edges.map((e: NetworkEdge) => ({
      source: (nodeById.get(e.from) ?? e.from) as SimNode,
      target: (nodeById.get(e.to) ?? e.to) as SimNode,
      weight: e.weight,
    }));

    const simulation = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(100).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(innerW / 2, innerH / 2))
      .force("collision", d3.forceCollide<SimNode>().radius((d) => rScale(d.messageCount) + 8));

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const g = svg
      .attr("width", width)
      .attr("height", HEIGHT)
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // Arrow marker
    svg.append("defs").append("marker")
      .attr("id", `arrow-${sessionIdHash(data)}`)
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 18)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L8,0L0,4")
      .attr("fill", "var(--border-default)");

    const link = g.selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", "var(--border-default)")
      .attr("stroke-width", (d) => Math.sqrt(d.weight) + 0.5)
      .attr("stroke-opacity", 0.6)
      .attr("marker-end", `url(#arrow-${sessionIdHash(data)})`);

    const node = g.selectAll("g.node")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "default");

    node.append("circle")
      .attr("r", (d) => rScale(d.messageCount))
      .attr("fill", (_, i) => AGENT_COLORS[i % AGENT_COLORS.length])
      .attr("opacity", 0.85)
      .on("mouseenter", function (_event, d) {
        const el = this as SVGElement;
        const rect = el.getBoundingClientRect();
        showTooltip(rect.left + rect.width / 2, rect.top - 8, `${d.name} · ${d.messageCount} msgs`);
      })
      .on("mouseleave", hideTooltip);

    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", "0.6rem")
      .attr("font-family", "var(--font-mono)")
      .attr("fill", "var(--text-primary)")
      .attr("dy", (d) => rScale(d.messageCount) + 10)
      .style("pointer-events", "none")
      .text((d) => d.name.length > 16 ? d.name.slice(0, 15) + "…" : d.name);

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);

      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
    };
  }, [data, showTooltip, hideTooltip]);

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <svg ref={svgRef} style={{ display: "block", overflow: "visible" }} />
      {tooltip && (
        <div style={{
          position: "fixed",
          left: tooltip.x,
          top: tooltip.y,
          transform: "translate(-50%, -100%)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius)",
          padding: "4px 8px",
          fontSize: "0.72rem",
          fontFamily: "var(--font-mono)",
          color: "var(--text-primary)",
          pointerEvents: "none",
          zIndex: 9999,
          whiteSpace: "nowrap",
        }}>
          {tooltip.content}
        </div>
      )}
    </div>
  );
}

// Stable hash of node count to make marker IDs unique per graph instance
function sessionIdHash(data: NetworkReport): string {
  return String(data.nodes.length);
}
