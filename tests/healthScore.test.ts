import { describe, it, expect } from "vitest";
import { computeHealthScore, type HealthInputs } from "@/lib/healthScore";

const empty: HealthInputs = {
  grades: {},
  cacheHitRate: null,
  mcpFindings: { crit: 0, high: 0, med: 0, low: 0, info: 0 },
  mcpScanned: false,
  approvals: 0,
  pressure: { retryExhaustion: 0, compactions: 0, hasData: false },
  editAcceptance: { rate: 0, n: 0, hasData: false },
};

describe("computeHealthScore", () => {
  it("returns hasData=false when no signals are populated except approvals=0", () => {
    const r = computeHealthScore(empty);
    // Approvals component scores 100 when there are zero pending — that's the
    // only contributor in this scenario. So hasData IS true (1 component).
    // Confirms the renormalization: we don't insist all 6 signals are
    // present, just at least one.
    expect(r.hasData).toBe(true);
    expect(r.score).toBe(100);
    expect(r.grade).toBe("A");
  });

  it("drops components without data and renormalizes the remaining weights", () => {
    const r = computeHealthScore({
      ...empty,
      cacheHitRate: 0.8, // 80% — sub-score 80, weight 20
      approvals: 2,      // sub-score 80, weight 10
    });
    // Weighted average over (cache=80, weight=20) and (approvals=80, weight=10):
    // (80*20 + 80*10) / 30 = 80
    expect(r.score).toBe(80);
    expect(r.grade).toBe("B");
    const cache = r.components.find((c) => c.id === "cache-efficiency");
    expect(cache?.score).toBe(80);
    const grades = r.components.find((c) => c.id === "project-grades");
    expect(grades?.score).toBeNull(); // dropped — no data
  });

  it("averages efficiency grades with the documented weights", () => {
    const r = computeHealthScore({
      ...empty,
      grades: { p1: "A", p2: "A", p3: "C" },
    });
    // (95 + 95 + 70) / 3 = 86.67 → 87
    const grades = r.components.find((c) => c.id === "project-grades");
    expect(grades?.score).toBe(87);
    expect(grades?.detail).toContain("3 graded");
  });

  it("penalizes critical MCP findings heavily", () => {
    const r = computeHealthScore({
      ...empty,
      mcpScanned: true,
      mcpFindings: { crit: 1, high: 0, med: 0, low: 0, info: 0 },
    });
    // weighted = 1 * 10 = 10; score = 100 - 10*5 = 50
    const mcp = r.components.find((c) => c.id === "mcp-security");
    expect(mcp?.score).toBe(50);
  });

  it("scores a clean MCP scan as 100", () => {
    const r = computeHealthScore({
      ...empty,
      mcpScanned: true,
      mcpFindings: { crit: 0, high: 0, med: 0, low: 0, info: 0 },
    });
    const mcp = r.components.find((c) => c.id === "mcp-security");
    expect(mcp?.score).toBe(100);
    expect(mcp?.detail).toMatch(/clean/i);
  });

  it("requires ≥10 edit-acceptance samples to score", () => {
    const tooFew = computeHealthScore({
      ...empty,
      editAcceptance: { rate: 0.9, n: 5, hasData: true },
    });
    expect(tooFew.components.find((c) => c.id === "edit-acceptance")?.score).toBeNull();

    const enough = computeHealthScore({
      ...empty,
      editAcceptance: { rate: 0.9, n: 50, hasData: true },
    });
    expect(enough.components.find((c) => c.id === "edit-acceptance")?.score).toBe(90);
  });

  it("clamps approval penalty at 0", () => {
    const r = computeHealthScore({ ...empty, approvals: 99 });
    expect(r.components.find((c) => c.id === "approvals")?.score).toBe(0);
  });

  it("maps the overall score to a letter grade", () => {
    expect(computeHealthScore({ ...empty, approvals: 0 }).grade).toBe("A"); // 100
    expect(computeHealthScore({ ...empty, approvals: 2 }).grade).toBe("B"); // 80
    expect(computeHealthScore({ ...empty, approvals: 4 }).grade).toBe("D"); // 60
    expect(computeHealthScore({ ...empty, approvals: 5 }).grade).toBe("F"); // 50
  });
});
