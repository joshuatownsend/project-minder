"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { D3Container } from "@/components/viz/D3Container";
import { computeLayout, extractTaskCards, truncateTitle, STATUS_COLOR } from "@/lib/kanban/dependencyLayout";
import type { KanbanSnapshot } from "@/lib/kanban/types";

const NODE_W = 180;
const NODE_H = 54;
const GAP_X = 80;
const GAP_Y = 16;
const PADDING = 24;

interface Props {
  snapshot: KanbanSnapshot;
}

export function TaskDependencyGraph({ snapshot }: Props) {
  const router = useRouter();

  const taskCards = useMemo(() => extractTaskCards(snapshot), [snapshot]);

  const nodesWithEdges = useMemo(() => {
    const edged = new Set<number>();
    for (const c of taskCards) {
      if (c.blockedBy.length > 0 || c.blocks.length > 0) edged.add(c.taskId);
    }
    return taskCards.filter((c) => edged.has(c.taskId));
  }, [taskCards]);

  const layout = useMemo(() => {
    const nodes = nodesWithEdges.map((c) => ({
      id: c.taskId,
      title: c.title,
      status: c.column,
      priority: 3,
      createdAt: c.createdAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      cancelled: c.cancelled,
      blockedBy: c.blockedBy,
      blocks: c.blocks,
    }));
    return computeLayout(nodes, NODE_W, NODE_H, GAP_X, GAP_Y);
  }, [nodesWithEdges]);

  if (nodesWithEdges.length === 0) {
    return (
      <div
        style={{
          padding: "64px 32px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "0.85rem",
        }}
      >
        No tasks with dependency edges.
        <br />
        Add a <strong>Depends on</strong> link in Task Composer to see the graph.
      </div>
    );
  }

  const maxLayerCount = Math.max(...layout.layerSizes);
  const svgWidth  = (layout.maxLayer + 1) * (NODE_W + GAP_X) - GAP_X + PADDING * 2;
  const svgHeight = maxLayerCount * (NODE_H + GAP_Y) - GAP_Y + PADDING * 2;

  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));

  // Build edge list: blocker → dependent (only in-graph edges).
  const edges: { fromId: number; toId: number }[] = [];
  for (const n of layout.nodes) {
    for (const bid of n.blockedBy) {
      if (nodeMap.has(bid)) edges.push({ fromId: bid, toId: n.id });
    }
  }

  return (
    <div style={{ overflowX: "auto", overflowY: "auto", padding: "8px 0" }}>
      <D3Container
        height={svgHeight + PADDING * 2}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        style={{ minWidth: svgWidth }}
      >
        {({ showTooltip, hideTooltip }) => (
          <g transform={`translate(${PADDING}, ${PADDING})`}>
            {/* Arrowhead marker */}
            <defs>
              <marker
                id="dep-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-default, #444)" />
              </marker>
            </defs>

            {/* Edges (drawn first, behind nodes) */}
            {edges.map(({ fromId, toId }) => {
              const from = nodeMap.get(fromId);
              const to = nodeMap.get(toId);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`${fromId}-${toId}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border-default, #444)"
                  strokeWidth={1.5}
                  markerEnd="url(#dep-arrow)"
                />
              );
            })}

            {/* Nodes */}
            {layout.nodes.map((n) => {
              const statusColor = STATUS_COLOR[n.status] ?? "var(--text-muted)";

              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => router.push(`/tasks?focus=${n.id}`)}
                  onMouseEnter={(e) => {
                    showTooltip(
                      e.clientX,
                      e.clientY,
                      `#${n.id} — ${n.title}${n.blockedBy.length > 0 ? `\nBlocked by: ${n.blockedBy.map((b) => `#${b}`).join(", ")}` : ""}`
                    );
                  }}
                  onMouseLeave={hideTooltip}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={5}
                    fill={`color-mix(in srgb, ${statusColor} 10%, var(--bg-elevated, #1c1f26))`}
                    stroke={statusColor}
                    strokeWidth={1.5}
                    style={{ transition: "stroke-width 0.15s" }}
                  />
                  <text
                    x={10}
                    y={20}
                    fontSize="0.7rem"
                    fontFamily="var(--font-mono)"
                    fill="var(--text-muted)"
                  >
                    #{n.id}
                  </text>
                  <text
                    x={10}
                    y={36}
                    fontSize="0.75rem"
                    fontFamily="var(--font-body)"
                    fontWeight={600}
                    fill="var(--text-primary)"
                  >
                    {truncateTitle(n.title)}
                  </text>
                  <text
                    x={10}
                    y={50}
                    fontSize="0.62rem"
                    fontFamily="var(--font-mono)"
                    fill={statusColor}
                    style={{ textTransform: "uppercase" }}
                  >
                    {n.status}
                  </text>
                </g>
              );
            })}
          </g>
        )}
      </D3Container>
    </div>
  );
}
