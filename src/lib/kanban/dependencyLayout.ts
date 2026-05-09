/**
 * Sugiyama-style layered layout for task dependency DAGs.
 * Shared by TaskDependencyGraph (SVG DAG view) and TaskGanttChart (Gantt rows).
 *
 * Assumes no cycles — enforced at DB insert time by addDependency's DFS check.
 * If a cycle somehow appears in the data (corrupt DB), nodes in the cycle
 * receive layer 0 and the layout degrades gracefully rather than looping.
 */

import type { KanbanSnapshot, KanbanCard } from "@/lib/kanban/types";

export interface LayoutNode {
  id: number;
  title: string;
  status: string;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelled: boolean;
  /** Ids that must be 'done' before this task can run. */
  blockedBy: number[];
  /** Ids that this task blocks. */
  blocks: number[];
}

export interface PositionedNode extends LayoutNode {
  layer: number;   // 0 = root (no blockers), higher = deeper in the chain
  order: number;   // within-layer index
  x: number;      // pixel x (set by caller after knowing layout bounds)
  y: number;      // pixel y
}

export interface DependencyLayout {
  nodes: PositionedNode[];
  /** Max layer index (0-based). */
  maxLayer: number;
  /** Count of nodes per layer. */
  layerSizes: number[];
}

/** Column-keyed status colors shared by DAG and Gantt views. */
export const STATUS_COLOR: Record<string, string> = {
  working: "var(--success, #22c55e)",
  waiting: "var(--accent)",
  idle:    "var(--text-muted)",
  done:    "var(--info)",
  error:   "var(--error)",
};

/** Extract all task cards from a KanbanSnapshot across all columns. */
export function extractTaskCards(
  snapshot: KanbanSnapshot
): Extract<KanbanCard, { kind: "task" }>[] {
  const result: Extract<KanbanCard, { kind: "task" }>[] = [];
  for (const cards of Object.values(snapshot.columns)) {
    for (const c of cards) {
      if (c.kind === "task") result.push(c);
    }
  }
  return result;
}

/** Truncate a title to maxLen chars, appending "…" if needed. */
export function truncateTitle(title: string, maxLen = 22): string {
  return title.length > maxLen ? title.slice(0, maxLen - 1) + "…" : title;
}

/**
 * Compute a layered layout for the given nodes.
 *
 * @param nodes - All task nodes that should appear in the graph.
 * @param nodeWidthPx - Width of each node rectangle.
 * @param nodeHeightPx - Height of each node rectangle.
 * @param gapXPx - Horizontal gap between layers.
 * @param gapYPx - Vertical gap between nodes in the same layer.
 */
export function computeLayout(
  nodes: LayoutNode[],
  nodeWidthPx: number,
  nodeHeightPx: number,
  gapXPx: number,
  gapYPx: number,
): DependencyLayout {
  if (nodes.length === 0) {
    return { nodes: [], maxLayer: 0, layerSizes: [] };
  }

  const idSet = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Longest-path layer assignment. Nodes with no in-graph blockers → layer 0.
  const layerMap = new Map<number, number>();

  function assignLayer(id: number, depth: number): number {
    if (depth > nodes.length) return 0; // cycle guard
    if (layerMap.has(id)) return layerMap.get(id)!;

    const node = nodeById.get(id);
    if (!node) { layerMap.set(id, 0); return 0; }

    const blockers = node.blockedBy.filter((b) => idSet.has(b));
    if (blockers.length === 0) {
      layerMap.set(id, 0);
      return 0;
    }

    const maxBlockerLayer = Math.max(...blockers.map((b) => assignLayer(b, depth + 1)));
    const layer = maxBlockerLayer + 1;
    layerMap.set(id, layer);
    return layer;
  }

  for (const n of nodes) assignLayer(n.id, 0);

  // Group nodes by layer, sort within each layer by (priority ASC, createdAt ASC).
  const byLayer = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const layer = layerMap.get(n.id) ?? 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(n);
  }

  for (const [, layerNodes] of byLayer) {
    layerNodes.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  const maxLayer = Math.max(...layerMap.values());
  const layerSizes: number[] = [];
  for (let l = 0; l <= maxLayer; l++) {
    layerSizes.push(byLayer.get(l)?.length ?? 0);
  }

  // Build per-node order index from the sorted layer arrays in O(n).
  const orderByid = new Map<number, number>();
  for (const [, layerNodes] of byLayer) {
    layerNodes.forEach((n, i) => orderByid.set(n.id, i));
  }

  const positioned: PositionedNode[] = nodes.map((n) => {
    const layer = layerMap.get(n.id) ?? 0;
    const order = orderByid.get(n.id) ?? 0;
    return {
      ...n,
      layer,
      order,
      x: layer * (nodeWidthPx + gapXPx),
      y: order * (nodeHeightPx + gapYPx),
    };
  });

  return { nodes: positioned, maxLayer, layerSizes };
}
