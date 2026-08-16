import { describe, it, expect } from "vitest";
import { sankey, sankeyJustify } from "d3-sankey";
import { buildSankeyFlow, breakCycles, type FlowEdge } from "@/lib/usage/sankeyFlow";
import { demoUsage } from "@/lib/demo/usage";
import type { ToolTransition } from "@/lib/usage/types";

/**
 * `src/lib/usage/sankeyFlow.ts` — the acyclic projection feeding the Tool
 * Execution Flow Sankey (#443).
 *
 * The defect these pin: d3-sankey throws `Error: circular link` on a cyclic
 * graph, from inside a `useMemo` during render. That did not produce a broken
 * chart — it took the whole `/usage` route down and the browser showed its own
 * error page. Tool transitions are consecutive tool pairs, so `Edit → Bash →
 * Edit` makes cycles the normal case rather than the exotic one.
 */

const t = (from: string, to: string, count: number): ToolTransition =>
  ({ from, to, count }) as ToolTransition;

/** Does the edge list contain a cycle? Written independently of the source. */
function hasCycle(edges: Array<{ from: string; to: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  for (const n of adj.keys()) if (visit(n)) return true;
  return false;
}

describe("breakCycles", () => {
  it("leaves an acyclic graph completely untouched", () => {
    // The identity case, and the one most worth pinning: a cycle-breaker that
    // quietly edits healthy data would corrupt every chart it touched, and
    // nothing downstream would reveal it.
    const edges: FlowEdge[] = [
      { from: "Read", to: "Edit", count: 10 },
      { from: "Edit", to: "Bash", count: 8 },
      { from: "Grep", to: "Read", count: 5 },
    ];
    const { kept, dropped } = breakCycles(edges);
    expect(dropped).toEqual([]);
    expect(kept).toEqual(edges);
  });

  it("breaks a 2-cycle by dropping the LOWER-count edge", () => {
    // Dropping the heavier edge would still render, and would still be
    // acyclic — and would misrepresent the dominant flow, which is the only
    // thing the chart exists to show.
    const { kept, dropped } = breakCycles([
      { from: "Edit", to: "Bash", count: 100 },
      { from: "Bash", to: "Edit", count: 3 },
    ]);
    expect(dropped).toEqual([{ from: "Bash", to: "Edit", count: 3 }]);
    expect(kept).toEqual([{ from: "Edit", to: "Bash", count: 100 }]);
  });

  it("breaks a 3-cycle and leaves the rest of the graph intact", () => {
    const { kept, dropped } = breakCycles([
      { from: "A", to: "B", count: 50 },
      { from: "B", to: "C", count: 40 },
      { from: "C", to: "A", count: 2 },
      { from: "D", to: "A", count: 30 },
    ]);
    expect(dropped).toEqual([{ from: "C", to: "A", count: 2 }]);
    expect(hasCycle(kept)).toBe(false);
    expect(kept).toContainEqual({ from: "D", to: "A", count: 30 });
  });

  it("resolves nested cycles sharing an edge", () => {
    const { kept, dropped } = breakCycles([
      { from: "A", to: "B", count: 9 },
      { from: "B", to: "A", count: 7 },
      { from: "B", to: "C", count: 8 },
      { from: "C", to: "B", count: 6 },
    ]);
    expect(hasCycle(kept)).toBe(false);
    expect(dropped.length).toBe(2);
  });

  it("is deterministic across repeated runs", () => {
    // Ties are broken lexicographically on purpose: a chart that reshuffled
    // between renders would be worse than one dropping a different edge.
    const edges: FlowEdge[] = [
      { from: "A", to: "B", count: 5 },
      { from: "B", to: "C", count: 5 },
      { from: "C", to: "A", count: 5 },
    ];
    const first = breakCycles(edges);
    for (let i = 0; i < 5; i++) {
      expect(breakCycles(edges)).toEqual(first);
    }
  });

  it("handles a graph where EVERY edge has to go", () => {
    // The worst case for the loop bound: N edges, N removals. Only reachable
    // through self-edges, since a single non-self edge cannot be a cycle.
    // `buildSankeyFlow` filters these out first, but `breakCycles` is exported
    // and has to hold on its own.
    const { kept, dropped } = breakCycles([
      { from: "A", to: "A", count: 5 },
      { from: "B", to: "B", count: 3 },
    ]);
    expect(kept).toEqual([]);
    expect(dropped.length).toBe(2);
    expect(hasCycle(kept)).toBe(false);
  });

  it("does not mutate its input", () => {
    const edges: FlowEdge[] = [
      { from: "A", to: "B", count: 2 },
      { from: "B", to: "A", count: 1 },
    ];
    const snapshot = JSON.parse(JSON.stringify(edges));
    breakCycles(edges);
    expect(edges).toEqual(snapshot);
  });
});

describe("buildSankeyFlow", () => {
  it("drops self-edges SILENTLY, without disclosing them as hidden cycles", () => {
    // The contract routes self-loops to a separate prop, so a self-edge here
    // is a contract violation — but it would take the page down just as
    // surely as a 2-cycle, so it is filtered rather than trusted.
    //
    // The `droppedEdges` assertion is the load-bearing one, and mutation
    // testing is why it exists: removing the explicit self-edge filter left
    // every other test green, because `breakCycles` also removes A→A (it is
    // a cycle). The two paths differ only in what the USER is told. A
    // self-loop is already drawn elsewhere on this chart, so reporting it as
    // a "hidden cyclic transition" would claim data was withheld when it is
    // on screen — filtering first keeps the disclosure honest.
    const { links, nodes, droppedEdges } = buildSankeyFlow(
      [t("Edit", "Edit", 50), t("Read", "Edit", 10)],
      12
    );
    const names = nodes.map((n) => n.name);
    expect(links.every((l) => l.source !== l.target)).toBe(true);
    expect(links.length).toBe(1);
    expect(names).toContain("Read");
    expect(droppedEdges).toEqual([]);
  });

  it("applies the top-N cut BEFORE breaking cycles", () => {
    // Order matters for minimal loss: the A→B→A cycle here runs through B,
    // which the top-1 cut removes. Breaking first would drop an edge to fix a
    // cycle the rendered graph never had.
    const transitions = [
      t("A", "B", 1),
      t("B", "A", 1),
      t("A", "C", 100),
      t("C", "A", 90),
    ];
    // topN=2 keeps A and C (highest throughput); the A/B cycle vanishes with B.
    const { droppedEdges } = buildSankeyFlow(transitions, 2);
    expect(droppedEdges.every((e) => e.from !== "B" && e.to !== "B")).toBe(true);
    // The surviving A↔C cycle still has to be broken, weakest edge first.
    expect(droppedEdges).toEqual([{ from: "C", to: "A", count: 90 }]);
  });

  it("reports dropped edges so the UI can disclose them", () => {
    const { droppedEdges } = buildSankeyFlow(
      [t("A", "B", 10), t("B", "A", 1)],
      12
    );
    expect(droppedEdges).toEqual([{ from: "B", to: "A", count: 1 }]);
  });

  it("returns empty output for empty input", () => {
    expect(buildSankeyFlow([], 12)).toEqual({ nodes: [], links: [], droppedEdges: [] });
  });

  it("omits nodes left with no edges after the break", () => {
    // A node stranded by the cycle break would otherwise draw as a bar with
    // nothing flowing through it.
    const { nodes } = buildSankeyFlow([t("A", "B", 5), t("B", "A", 5)], 12);
    expect(nodes.length).toBeLessThanOrEqual(2);
    expect(nodes.length).toBeGreaterThan(0);
  });
});

describe("d3-sankey acceptance (the actual regression)", () => {
  /** Exactly what the component does, minus the SVG. */
  function layout(transitions: ToolTransition[], topN: number) {
    const { nodes, links } = buildSankeyFlow(transitions, topN);
    if (links.length === 0) return null;
    return sankey<{ name: string }, { source: number; target: number; value: number }>()
      .nodeWidth(18)
      .nodePadding(10)
      .nodeAlign(sankeyJustify)
      .extent([[0, 0], [384, 288]])(
      { nodes: nodes as any, links: links as any }
    );
  }

  it("lays out the REAL demo fixture without throwing", () => {
    // This is the regression. `MINDER_DEMO=1` + /usage threw
    // `Error: circular link` and Chromium replaced the page with its own
    // error screen; the fixture's Read→Edit→Bash→Read loop is the cause.
    //
    // Deliberately driving the real fixture through the real d3-sankey:
    // checking the output with our own cycle detector would only prove our
    // code agrees with itself, and it was d3-sankey's opinion that took the
    // page down.
    const { report } = demoUsage("all", undefined, Date.UTC(2026, 7, 15));
    expect(report.toolTransitions.length).toBeGreaterThan(0);
    expect(hasCycle(report.toolTransitions)).toBe(true); // precondition
    for (const topN of [5, 8, 12, 20, 30]) {
      expect(() => layout(report.toolTransitions, topN)).not.toThrow();
    }
  });

  it("lays out a dense synthetic cycle-heavy graph without throwing", () => {
    // Every ordered pair among 6 tools — maximally cyclic, well past what a
    // real corpus produces.
    const tools = ["Read", "Edit", "Bash", "Grep", "Glob", "Task"];
    const transitions: ToolTransition[] = [];
    for (const a of tools) {
      for (const b of tools) {
        if (a !== b) transitions.push(t(a, b, (a.length * 7 + b.length * 3) % 19 + 1));
      }
    }
    expect(hasCycle(transitions)).toBe(true);
    for (const topN of [5, 12, 30]) {
      expect(() => layout(transitions, topN)).not.toThrow();
    }
  });

  it("still throws without the projection — proving the fixture is the trigger", () => {
    // Guards against the test above passing for the wrong reason. If the demo
    // fixture ever stops being cyclic, this fails and tells us the regression
    // test has quietly stopped covering the bug.
    const { report } = demoUsage("all", undefined, Date.UTC(2026, 7, 15));
    const raw: ToolTransition[] = report.toolTransitions;
    const names = [...new Set(raw.flatMap((x: ToolTransition) => [x.from, x.to]))];
    const idx = new Map(names.map((n, i) => [n, i]));
    expect(() =>
      sankey<{ name: string }, { source: number; target: number; value: number }>()
        .nodeWidth(18)
        .nodePadding(10)
        .extent([[0, 0], [384, 288]])({
        nodes: names.map((name) => ({ name })) as any,
        links: raw.map((x: ToolTransition) => ({
          source: idx.get(x.from)!,
          target: idx.get(x.to)!,
          value: x.count,
        })) as any,
      })
    ).toThrow(/circular link/);
  });
});
