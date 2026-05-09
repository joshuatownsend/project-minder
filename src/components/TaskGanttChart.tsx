"use client";

import { useMemo } from "react";
import * as d3 from "d3";
import { D3Container } from "@/components/viz/D3Container";
import { computeLayout } from "@/lib/kanban/dependencyLayout";
import type { KanbanSnapshot, KanbanCard } from "@/lib/kanban/types";

const ROW_H = 24;
const ROW_GAP = 8;
const LABEL_W = 160;
const AXIS_H = 28;
const PLACEHOLDER_MIN = 30 * 60 * 1000; // 30 min in ms (visual only)

const STATUS_COLOR: Record<string, string> = {
  working:          "var(--success, #22c55e)",
  waiting:          "var(--accent)",
  idle:             "var(--text-muted)",
  done:             "var(--info)",
  error:            "var(--error)",
};

interface Props {
  snapshot: KanbanSnapshot;
}

export function TaskGanttChart({ snapshot }: Props) {
  const taskCards = useMemo(() => {
    const all: Extract<KanbanCard, { kind: "task" }>[] = [];
    for (const cards of Object.values(snapshot.columns)) {
      for (const c of cards) {
        if (c.kind === "task") all.push(c);
      }
    }
    return all;
  }, [snapshot]);

  const layout = useMemo(() => {
    const nodes = taskCards.map((c) => ({
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
    return computeLayout(nodes, 1, ROW_H, 0, ROW_GAP);
  }, [taskCards]);

  if (layout.nodes.length === 0) {
    return (
      <div
        style={{
          padding: "64px 32px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "0.85rem",
        }}
      >
        No task activity yet.
      </div>
    );
  }

  const now = Date.now();

  // Compute time bounds across all tasks.
  let minTime = now;
  let maxTime = now;
  for (const n of layout.nodes) {
    const start = n.startedAt
      ? new Date(n.startedAt).getTime()
      : new Date(n.createdAt).getTime();
    const end = n.completedAt
      ? new Date(n.completedAt).getTime()
      : n.status === "working" || n.status === "waiting"
        ? now
        : new Date(n.createdAt).getTime() + PLACEHOLDER_MIN;
    if (start < minTime) minTime = start;
    if (end > maxTime) maxTime = end;
  }
  // Pad 5% on each side.
  const span = Math.max(maxTime - minTime, PLACEHOLDER_MIN);
  minTime = minTime - span * 0.05;
  maxTime = maxTime + span * 0.05;

  const totalRows = layout.nodes.length;
  const svgHeight = totalRows * (ROW_H + ROW_GAP) + AXIS_H;

  // Build edge set for dependency arrows.
  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));
  const edges: { fromId: number; toId: number }[] = [];
  for (const n of layout.nodes) {
    for (const bid of n.blockedBy) {
      if (nodeMap.has(bid)) edges.push({ fromId: bid, toId: n.id });
    }
  }

  return (
    <div style={{ overflowX: "auto", padding: "8px 0" }}>
      <D3Container
        height={svgHeight + 16}
        margin={{ top: 8, right: 16, bottom: AXIS_H, left: LABEL_W }}
      >
        {({ width, showTooltip, hideTooltip }) => {
          const xScale = d3.scaleTime()
            .domain([new Date(minTime), new Date(maxTime)])
            .range([0, width]);
          const tickValues = xScale.ticks(6);
          const tickFmt = d3.timeFormat(
            (maxTime - minTime) < 24 * 3600 * 1000 ? "%H:%M" : "%b %d"
          );

          return (
            <g>
              {/* Horizontal grid lines */}
              {layout.nodes.map((n) => {
                const rowY = n.order * (ROW_H + ROW_GAP);
                return (
                  <line
                    key={`grid-${n.id}`}
                    x1={0} y1={rowY + ROW_H / 2}
                    x2={width} y2={rowY + ROW_H / 2}
                    stroke="var(--border-default, #333)"
                    strokeWidth={0.5}
                    strokeDasharray="3,4"
                  />
                );
              })}

              {/* Dependency arrows (drawn before bars) */}
              {edges.map(({ fromId, toId }) => {
                const from = nodeMap.get(fromId);
                const to   = nodeMap.get(toId);
                if (!from || !to) return null;

                const fromEnd = from.completedAt
                  ? new Date(from.completedAt).getTime()
                  : from.status === "working" ? now
                  : new Date(from.createdAt).getTime() + PLACEHOLDER_MIN;
                const toStart = to.startedAt
                  ? new Date(to.startedAt).getTime()
                  : new Date(to.createdAt).getTime();

                const x1 = xScale(new Date(fromEnd));
                const y1 = from.order * (ROW_H + ROW_GAP) + ROW_H / 2;
                const x2 = xScale(new Date(toStart));
                const y2 = to.order * (ROW_H + ROW_GAP) + ROW_H / 2;

                return (
                  <path
                    key={`dep-${fromId}-${toId}`}
                    d={`M ${x1} ${y1} Q ${x1 + 20} ${y1}, ${x1 + 20} ${(y1 + y2) / 2} T ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--text-muted)"
                    strokeWidth={1}
                    strokeDasharray="4,3"
                    markerEnd="url(#gantt-arrow)"
                  />
                );
              })}

              {/* Arrow marker */}
              <defs>
                <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth={5} markerHeight={5} orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--text-muted)" />
                </marker>
              </defs>

              {/* Task bars + labels */}
              {layout.nodes.map((n) => {
                const rowY = n.order * (ROW_H + ROW_GAP);
                const color = STATUS_COLOR[n.status] ?? "var(--text-muted)";

                const startMs = n.startedAt
                  ? new Date(n.startedAt).getTime()
                  : new Date(n.createdAt).getTime();
                const endMs = n.completedAt
                  ? new Date(n.completedAt).getTime()
                  : (n.status === "working" || n.status === "waiting")
                    ? now
                    : startMs + PLACEHOLDER_MIN;

                const barX = xScale(new Date(startMs));
                const barW = Math.max(4, xScale(new Date(endMs)) - barX);
                const isPlaceholder = !n.startedAt;

                const label = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;

                return (
                  <g key={n.id}>
                    {/* Row label (left margin area) */}
                    <text
                      x={-8}
                      y={rowY + ROW_H / 2}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize="0.68rem"
                      fontFamily="var(--font-mono)"
                      fill="var(--text-secondary)"
                    >
                      {label}
                    </text>

                    {/* Bar */}
                    <rect
                      x={barX}
                      y={rowY + 2}
                      width={barW}
                      height={ROW_H - 4}
                      rx={3}
                      fill={isPlaceholder
                        ? "transparent"
                        : `color-mix(in srgb, ${color} 35%, transparent)`
                      }
                      stroke={color}
                      strokeWidth={isPlaceholder ? 1 : 0}
                      strokeDasharray={isPlaceholder ? "4,3" : undefined}
                      style={{ cursor: "pointer" }}
                      onMouseEnter={(e) => showTooltip(e.clientX, e.clientY,
                        `#${n.id} ${n.title}\n${n.status}${n.cancelled ? " (cancelled)" : ""}`
                      )}
                      onMouseLeave={hideTooltip}
                    />
                  </g>
                );
              })}

              {/* X axis */}
              <g transform={`translate(0, ${totalRows * (ROW_H + ROW_GAP)})`}>
                <line x1={0} y1={0} x2={width} y2={0} stroke="var(--border-default, #333)" />
                {tickValues.map((t, i) => (
                  <g key={i} transform={`translate(${xScale(t)}, 0)`}>
                    <line y1={0} y2={5} stroke="var(--border-default, #333)" />
                    <text
                      y={16}
                      textAnchor="middle"
                      fontSize="0.62rem"
                      fontFamily="var(--font-mono)"
                      fill="var(--text-muted)"
                    >
                      {tickFmt(t)}
                    </text>
                  </g>
                ))}
              </g>
            </g>
          );
        }}
      </D3Container>
    </div>
  );
}
