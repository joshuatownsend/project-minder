"use client";

import { useEffect, useState, useMemo } from "react";
import * as d3 from "d3";
import { D3Container } from "./D3Container";
import { agentColor } from "./agentPalette";
import type { OrchestrationGraph, OrchNode } from "@/lib/usage/orchestrationGraph";

// Stateless path generator — created once at module scope
type TreeNodeData = { id: string; node: OrchNode; children: TreeNodeData[] };
const dagLinkGen = d3.linkHorizontal<unknown, d3.HierarchyPointNode<TreeNodeData>>()
  .x((d) => d.y)
  .y((d) => d.x);

interface Props {
  sessionId: string;
}

export function OrchestrationDAG({ sessionId }: Props) {
  const [graph, setGraph] = useState<OrchestrationGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/orchestration`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setGraph(data as OrchestrationGraph);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load orchestration data");
        setLoading(false);
      });
  }, [sessionId]);

  if (loading) {
    return (
      <div style={{ padding: "32px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        Loading orchestration graph…
      </div>
    );
  }

  if (error || !graph) {
    return (
      <div style={{ padding: "32px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        {error ?? "No data"}
      </div>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <div style={{ padding: "32px", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        No subagent activity in this session.
      </div>
    );
  }

  return (
    <D3Container height={400} margin={{ top: 20, right: 120, bottom: 20, left: 40 }}>
      {({ width, height, showTooltip, hideTooltip }) => (
        <OrchDAGInner
          graph={graph}
          width={width}
          height={height}
          showTooltip={showTooltip}
          hideTooltip={hideTooltip}
        />
      )}
    </D3Container>
  );
}

function OrchDAGInner({
  graph,
  width,
  height,
  showTooltip,
  hideTooltip,
}: {
  graph: OrchestrationGraph;
  width: number;
  height: number;
  showTooltip: (x: number, y: number, content: string) => void;
  hideTooltip: () => void;
}) {
  const { nodes, links, agentColorMap } = useMemo(() => {
    const nodeMap = new Map<string, OrchNode>(graph.nodes.map((n) => [n.id, n]));
    const edgeMap = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const arr = edgeMap.get(edge.from) ?? [];
      arr.push(edge.to);
      edgeMap.set(edge.from, arr);
    }

    const hasParent = new Set(graph.edges.map((e) => e.to));
    const roots = graph.nodes.filter((n) => !hasParent.has(n.id));

    function buildTree(nodeId: string): TreeNodeData {
      const node = nodeMap.get(nodeId)!;
      const childIds = edgeMap.get(nodeId) ?? [];
      return { id: nodeId, node, children: childIds.map(buildTree) };
    }

    const virtualRoot: TreeNodeData = {
      id: "__root__",
      node: { id: "__root__", toolName: "Session", depth: -1 },
      children: roots.map((r) => buildTree(r.id)),
    };

    const hierarchy = d3.hierarchy(virtualRoot, (d) => d.children);
    const treeRoot = d3.tree<TreeNodeData>().size([height, width - 60])(hierarchy);

    const nodes = treeRoot.descendants().filter((d) => d.data.id !== "__root__");
    const links = treeRoot.links().filter(
      (l) => l.source.data.id !== "__root__" && l.target.data.id !== "__root__"
    );

    const agentColorMap = new Map<string, string>();
    let colorIdx = 0;
    for (const n of graph.nodes) {
      if (n.agentName && !agentColorMap.has(n.agentName)) {
        agentColorMap.set(n.agentName, agentColor(n.agentName, colorIdx++));
      }
    }

    return { nodes, links, agentColorMap };
  }, [graph, width, height]);

  return (
    <g>
      {links.map((link) => (
        <path
          key={`${link.source.data.id}→${link.target.data.id}`}
          d={dagLinkGen(link as any) ?? ""}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={1.5}
        />
      ))}
      {nodes.map((d) => {
        const nodeData = d.data.node;
        const color = nodeData.agentName
          ? (agentColorMap.get(nodeData.agentName) ?? "var(--text-secondary)")
          : "var(--text-secondary)";
        const isError = nodeData.status === "error";
        const isOverflow = nodeData.toolName.startsWith("+");

        return (
          <g
            key={nodeData.id}
            transform={`translate(${d.y},${d.x})`}
            style={{ cursor: "default" }}
            onMouseEnter={(e) => {
              const label = [
                nodeData.toolName,
                nodeData.agentName,
                `depth ${nodeData.depth}`,
              ]
                .filter(Boolean)
                .join(" · ");
              showTooltip(e.clientX, e.clientY - 8, label);
            }}
            onMouseLeave={hideTooltip}
          >
            <circle
              r={7}
              fill={isOverflow ? "var(--bg-elevated)" : (isError ? "var(--status-error-text)" : color)}
              stroke={isError ? "var(--status-error-text)" : "var(--border-default)"}
              strokeWidth={1.5}
              fillOpacity={isOverflow ? 0.4 : 0.85}
            />
            <text
              x={12}
              dominantBaseline="middle"
              fontSize="0.62rem"
              fill={isOverflow ? "var(--text-muted)" : "var(--text-secondary)"}
              fontFamily="var(--font-mono)"
            >
              {nodeData.agentName ?? nodeData.toolName}
            </text>
          </g>
        );
      })}
    </g>
  );
}
