"use client";

import { useState, useEffect } from "react";
import type { OrchestrationGraph, OrchNode } from "@/lib/usage/orchestrationGraph";

interface AgentTreeViewProps {
  sessionId: string;
}

export function AgentTreeView({ sessionId }: AgentTreeViewProps) {
  const [graph, setGraph] = useState<OrchestrationGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    const controller = new AbortController();
    fetch(`/api/agent-view/tree?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("fetch-error");
        return r.json();
      })
      .then((data: { graph: OrchestrationGraph | null }) => {
        setGraph(data.graph);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  if (loading) {
    return (
      <div style={{ color: "var(--text-4,#555)", fontSize: "0.7rem", padding: "12px 0" }}>
        Loading sub-agent tree…
      </div>
    );
  }

  if (error || !graph || graph.nodes.length === 0) {
    return (
      <div style={{ color: "var(--text-4,#555)", fontSize: "0.7rem", padding: "12px 0" }}>
        {error ? "Failed to load tree." : "No sub-agent activity recorded for this session."}
      </div>
    );
  }

  // Build child map from edges
  const childMap = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const children = childMap.get(edge.from) ?? [];
    children.push(edge.to);
    childMap.set(edge.from, children);
  }
  const allTargets = new Set(graph.edges.map((e) => e.to));
  const roots = graph.nodes.filter((n) => !allTargets.has(n.id));
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <div style={{ fontFamily: "var(--font-mono,monospace)", fontSize: "0.68rem" }}>
      {roots.map((root) => (
        <TreeNode key={root.id} node={root} childMap={childMap} nodeMap={nodeMap} />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  childMap,
  nodeMap,
  indent = 0,
}: {
  node: OrchNode;
  childMap: Map<string, string[]>;
  nodeMap: Map<string, OrchNode>;
  indent?: number;
}) {
  const children = (childMap.get(node.id) ?? [])
    .map((id) => nodeMap.get(id))
    .filter((n): n is OrchNode => n !== undefined);

  const statusColor =
    node.status === "error" ? "var(--red-text,#f87171)"
    : node.status === "ok" ? "var(--green-text,#4ade80)"
    : "var(--text-3,#888)";

  return (
    <div style={{ paddingLeft: indent * 16, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 4 }}>
        <span style={{ color: statusColor, flexShrink: 0 }}>
          {indent === 0 ? "◆" : "└─"}
        </span>
        <span style={{ color: "var(--text-2,#ccc)" }}>
          {node.agentName ?? node.toolName}
        </span>
        {node.agentName && (
          <span style={{ color: "var(--text-4,#555)" }}>
            ({node.toolName})
          </span>
        )}
        <span style={{ color: "var(--text-4,#555)", marginLeft: "auto" }}>
          depth {node.depth}
        </span>
      </div>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          childMap={childMap}
          nodeMap={nodeMap}
          indent={indent + 1}
        />
      ))}
    </div>
  );
}
