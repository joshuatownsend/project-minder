"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
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
      <div style={{ color: "var(--text-3,#8a8c8f)", fontSize: "0.7rem", padding: "12px 0" }}>
        Loading sub-agent tree…
      </div>
    );
  }

  if (error || !graph || graph.nodes.length === 0) {
    return (
      <div style={{ color: "var(--text-3,#8a8c8f)", fontSize: "0.7rem", padding: "12px 0" }}>
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
  const [descOpen, setDescOpen] = useState(false);
  const children = (childMap.get(node.id) ?? [])
    .map((id) => nodeMap.get(id))
    .filter((n): n is OrchNode => n !== undefined);

  const statusColor =
    node.status === "error" ? "var(--red-text,#f87171)"
    : node.status === "ok" ? "var(--green-text,#4ade80)"
    : "var(--text-3,#888)";

  const hasCatalog = !!node.catalogEmoji || !!node.catalogColor || !!node.catalogDescription;
  const agentLabel = node.agentName ?? node.toolName;

  return (
    <div style={{ paddingLeft: indent * 16, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 4 }}>
        <span style={{ color: statusColor, flexShrink: 0 }}>
          {indent === 0 ? "◆" : "└─"}
        </span>
        {/* Agent label — linked when catalog matched, plain when unknown */}
        {hasCatalog && node.agentName ? (
          <Link
            href={`/agents?q=${encodeURIComponent(node.agentName)}`}
            style={{
              color: node.catalogColor ?? "var(--blue-text,#60a5fa)",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            {node.catalogEmoji && <span>{node.catalogEmoji}</span>}
            <span>{agentLabel}</span>
          </Link>
        ) : (
          <span style={{ color: "var(--text-2,#ccc)" }}>{agentLabel}</span>
        )}
        {node.agentName && node.toolName !== node.agentName && (
          <span style={{ color: "var(--text-3,#8a8c8f)" }}>
            ({node.toolName})
          </span>
        )}
        {/* Description peek toggle */}
        {node.catalogDescription && (
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            aria-label={descOpen ? "Hide description" : "Show description"}
            aria-expanded={descOpen}
            title={descOpen ? "Hide description" : "Show description"}
            style={{
              background: "none", border: "none",
              color: "var(--text-3,#8a8c8f)", cursor: "pointer",
              fontSize: "0.6rem", padding: "0 2px",
            }}
          >
            ⓘ
          </button>
        )}
        <span style={{ color: "var(--text-3,#8a8c8f)", marginLeft: "auto" }}>
          depth {node.depth}
        </span>
      </div>
      {descOpen && node.catalogDescription && (
        <div style={{
          paddingLeft: (indent + 1) * 16,
          paddingBottom: 4,
          fontSize: "0.6rem",
          color: "var(--text-3,#888)",
          fontFamily: "inherit",
        }}>
          {node.catalogDescription}
        </div>
      )}
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
