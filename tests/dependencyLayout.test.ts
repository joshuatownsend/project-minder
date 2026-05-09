import { describe, it, expect } from "vitest";
import { computeLayout, type LayoutNode } from "@/lib/kanban/dependencyLayout";

const NOW = "2026-05-08T12:00:00.000Z";

function makeNode(id: number, overrides: Partial<LayoutNode> = {}): LayoutNode {
  return {
    id,
    title: `Task ${id}`,
    status: "idle",
    priority: 3,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    cancelled: false,
    blockedBy: [],
    blocks: [],
    ...overrides,
  };
}

const W = 180, H = 54, GX = 80, GY = 16;

describe("computeLayout", () => {
  it("returns empty for no nodes", () => {
    const result = computeLayout([], W, H, GX, GY);
    expect(result.nodes).toHaveLength(0);
    expect(result.maxLayer).toBe(0);
    expect(result.layerSizes).toHaveLength(0);
  });

  it("places a single node with no blockers at layer 0", () => {
    const result = computeLayout([makeNode(1)], W, H, GX, GY);
    expect(result.nodes[0].layer).toBe(0);
    expect(result.nodes[0].x).toBe(0);
    expect(result.maxLayer).toBe(0);
  });

  it("single chain: A blocks B — B is layer 1", () => {
    const a = makeNode(1);
    const b = makeNode(2, { blockedBy: [1], blocks: [] });
    const result = computeLayout([a, b], W, H, GX, GY);
    const nodeA = result.nodes.find((n) => n.id === 1)!;
    const nodeB = result.nodes.find((n) => n.id === 2)!;
    expect(nodeA.layer).toBe(0);
    expect(nodeB.layer).toBe(1);
    expect(nodeB.x).toBe(W + GX);
  });

  it("diamond: A blocks B and C; B and C both block D — D is layer 2", () => {
    const a = makeNode(1);
    const b = makeNode(2, { blockedBy: [1] });
    const c = makeNode(3, { blockedBy: [1] });
    const d = makeNode(4, { blockedBy: [2, 3] });
    const result = computeLayout([a, b, c, d], W, H, GX, GY);
    const layerOf = (id: number) => result.nodes.find((n) => n.id === id)!.layer;
    expect(layerOf(1)).toBe(0);
    expect(layerOf(2)).toBe(1);
    expect(layerOf(3)).toBe(1);
    expect(layerOf(4)).toBe(2);
    expect(result.maxLayer).toBe(2);
  });

  it("disconnected components: each root starts at layer 0", () => {
    const a = makeNode(1);
    const b = makeNode(2);
    const result = computeLayout([a, b], W, H, GX, GY);
    expect(result.nodes.every((n) => n.layer === 0)).toBe(true);
  });

  it("within-layer ordering: lower priority wins", () => {
    const high = makeNode(1, { priority: 1 });
    const low  = makeNode(2, { priority: 5 });
    const result = computeLayout([low, high], W, H, GX, GY); // inserted reversed
    const n1 = result.nodes.find((n) => n.id === 1)!;
    const n2 = result.nodes.find((n) => n.id === 2)!;
    expect(n1.order).toBeLessThan(n2.order);
  });

  it("layerSizes matches node distribution per layer", () => {
    const a = makeNode(1);
    const b = makeNode(2, { blockedBy: [1] });
    const c = makeNode(3, { blockedBy: [1] });
    const result = computeLayout([a, b, c], W, H, GX, GY);
    expect(result.layerSizes[0]).toBe(1); // layer 0: just a
    expect(result.layerSizes[1]).toBe(2); // layer 1: b and c
  });

  it("ignores blockers not in the node set (out-of-graph references)", () => {
    // Node 2 claims to be blocked by node 99, which is not in the input.
    const b = makeNode(2, { blockedBy: [99] });
    const result = computeLayout([b], W, H, GX, GY);
    // Node 2 has no in-graph blocker → layer 0
    expect(result.nodes[0].layer).toBe(0);
  });
});
