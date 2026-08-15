import type { ToolTransition } from "./types";

// Graph preparation for the Tool Execution Flow Sankey (#443).
//
// d3-sankey requires a DAG and throws `Error: circular link` from
// `computeNodeDepths` the moment it finds a cycle. That throw happens inside
// a `useMemo` during render, so it is not a broken chart — it takes the whole
// `/usage` route down and the browser shows its own error page.
//
// The trouble is that this data is *inherently* cyclic. Transitions are
// consecutive tool pairs, and `Edit → Bash → Edit` is the most ordinary
// workflow there is, so any real corpus produces 2-cycles immediately. A
// Sankey is simply the wrong shape for the raw graph, and the fix is to feed
// it an acyclic projection rather than to hope the data behaves.
//
// Extracted from the component so it can be tested directly: the component
// renders SVG, this decides what the SVG shows.

/** One tool→tool edge, before it is turned into d3 index references. */
export interface FlowEdge {
  from: string;
  to: string;
  count: number;
}

export interface SankeyFlowResult {
  nodes: Array<{ name: string }>;
  links: Array<{ source: number; target: number; value: number }>;
  /**
   * Edges removed to make the graph acyclic, weakest-first. Surfaced so the
   * UI can say so: a Sankey quietly missing edges reads as a complete picture
   * of the flow when it is not, and this repo's standing rule is that a cap
   * which changes what you see has to be visible.
   */
  droppedEdges: FlowEdge[];
}

/** Adjacency list, deterministically ordered so cycle discovery is stable. */
function buildAdjacency(edges: FlowEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

/**
 * One cycle as a node path (`[a, b, c, a]`), or null when the graph is a DAG.
 *
 * Plain three-colour DFS. Returns the FIRST cycle found rather than all of
 * them, because the caller removes an edge and asks again — enumerating every
 * cycle up front would be wasted work, since breaking one often breaks
 * several.
 */
function findCycle(adj: Map<string, string[]>): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (node: string): void => {
    if (found) return;
    color.set(node, GREY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (found) return;
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        // `next` is on the current stack, so the path from it to here plus
        // this edge closes a cycle.
        found = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (c === WHITE) visit(next);
    }
    if (!found) {
      color.set(node, BLACK);
      stack.pop();
    }
  };

  // Sorted roots so the cycle we happen to find — and therefore the edge we
  // drop — does not depend on Map insertion order.
  for (const node of [...adj.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    if (found) break;
  }
  return found;
}

/**
 * Remove the fewest, least important edges needed to make `edges` acyclic.
 *
 * Greedy: find a cycle, drop its LOWEST-count edge, repeat. Dropping the
 * weakest edge preserves the dominant flow, which is the entire point of the
 * chart — removing a heavy edge to save a light one would misrepresent the
 * shape while still technically rendering.
 *
 * Deliberately not a minimum feedback arc set: that is NP-hard, and this
 * graph is capped at 30 nodes by the UI's own slider. Greedy is optimal
 * often enough and always correct, since it cannot terminate while a cycle
 * remains.
 *
 * Ties break lexicographically so the result is stable across runs — a chart
 * that silently reshuffles between renders would be worse than one that drops
 * a slightly different edge.
 */
export function breakCycles(edges: FlowEdge[]): { kept: FlowEdge[]; dropped: FlowEdge[] } {
  const kept = [...edges];
  const dropped: FlowEdge[] = [];

  // Each pass removes exactly one edge, so this cannot exceed the edge count.
  // Bounded rather than `while (true)` because an infinite render loop is a
  // worse failure than an imperfect chart.
  for (let pass = 0; pass <= edges.length; pass++) {
    const cycle = findCycle(buildAdjacency(kept));
    if (!cycle) break;

    const cycleEdges: FlowEdge[] = [];
    for (let i = 0; i + 1 < cycle.length; i++) {
      const edge = kept.find((k) => k.from === cycle[i] && k.to === cycle[i + 1]);
      if (edge) cycleEdges.push(edge);
    }
    // Defensive: a cycle whose edges we cannot locate would loop forever.
    if (cycleEdges.length === 0) break;

    cycleEdges.sort(
      (a, b) =>
        a.count - b.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    );
    const victim = cycleEdges[0];
    kept.splice(kept.indexOf(victim), 1);
    dropped.push(victim);
  }

  return { kept, dropped };
}

/**
 * Build the node/link arrays d3-sankey consumes, guaranteed acyclic.
 *
 * Step order is load-bearing:
 *
 *   1. Pick the top-N nodes by throughput, and keep only edges whose BOTH
 *      endpoints survive.
 *   2. Drop self-edges.
 *   3. Break remaining cycles.
 *
 * Filtering before breaking is what keeps the loss minimal. A cycle that runs
 * through a node the top-N cut removes is not a cycle in the rendered graph,
 * so breaking first would drop an edge to fix a problem the view never had.
 * Filtering cannot create a cycle, so the order is safe in the other
 * direction too.
 *
 * Self-edges are dropped even though the contract puts them in a separate
 * `selfLoops` prop: `A → A` is a cycle to d3-sankey as surely as `A → B → A`,
 * and defending against a contract violation here is cheaper than another
 * dead page if one ever appears in `transitions`.
 */
export function buildSankeyFlow(
  transitions: ToolTransition[],
  topN: number
): SankeyFlowResult {
  const throughput = new Map<string, number>();
  for (const t of transitions) {
    throughput.set(t.from, (throughput.get(t.from) ?? 0) + t.count);
    throughput.set(t.to, (throughput.get(t.to) ?? 0) + t.count);
  }

  const topNodes = new Set(
    [...throughput.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([name]) => name)
  );

  const filtered: FlowEdge[] = transitions
    .filter((t) => topNodes.has(t.from) && topNodes.has(t.to) && t.from !== t.to)
    .map((t) => ({ from: t.from, to: t.to, count: t.count }));

  const { kept, dropped } = breakCycles(filtered);

  // Only nodes still touched by an edge are worth drawing; a node stranded by
  // the cycle break would otherwise render as a bar with nothing flowing
  // through it.
  const usedNames = [...topNodes].filter((name) =>
    kept.some((e) => e.from === name || e.to === name)
  );
  const nodeIndex = new Map(usedNames.map((name, i) => [name, i]));

  return {
    nodes: usedNames.map((name) => ({ name })),
    links: kept.map((e) => ({
      source: nodeIndex.get(e.from)!,
      target: nodeIndex.get(e.to)!,
      value: e.count,
    })),
    droppedEdges: dropped,
  };
}
