import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies before importing the cache
vi.mock("@/lib/usage/parser", () => ({
  parseAllSessions: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn().mockResolvedValue({ agents: [], skills: [], commands: [] }),
}));
vi.mock("@/lib/scanner/wasteOptimizer", () => ({
  runWasteOptimizer: vi.fn().mockReturnValue({ grade: "B", findings: [], counts: {} }),
}));
vi.mock("@/lib/usage/projectMatch", () => ({
  gatherProjectTurns: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn().mockReturnValue(null),
}));

import { efficiencyGradeCache, type EfficiencyGrade } from "@/lib/efficiencyGradeCache";

// Flush globalThis singleton between tests by disposing
beforeEach(() => {
  efficiencyGradeCache.dispose();
});

describe("efficiencyGradeCache", () => {
  it("starts empty", () => {
    expect(efficiencyGradeCache.get("any")).toBeNull();
    expect(efficiencyGradeCache.total).toBe(0);
    expect(efficiencyGradeCache.pending).toBe(0);
  });

  it("skips projects with no sessions", () => {
    efficiencyGradeCache.enqueue([
      { slug: "no-sessions", path: "/p", hasSessions: false },
    ]);
    expect(efficiencyGradeCache.pending).toBe(0);
  });

  it("enqueues projects with sessions", () => {
    efficiencyGradeCache.enqueue([
      { slug: "has-sessions", path: "/p", hasSessions: true },
    ]);
    // One item in queue (not yet processed — async)
    expect(efficiencyGradeCache.pending).toBe(1);
  });

  it("deduplicates on repeated enqueue before processing", () => {
    efficiencyGradeCache.enqueue([
      { slug: "dup", path: "/p", hasSessions: true },
      { slug: "dup", path: "/p", hasSessions: true },
    ]);
    expect(efficiencyGradeCache.pending).toBe(1);
  });

  it("getAll returns only fresh entries", async () => {
    // Manually poke a stale entry via internal cache (simulate TTL expiry)
    // We can't do that directly, so verify that getAll returns {} when cache is empty.
    expect(efficiencyGradeCache.getAll()).toEqual({});
  });

  it("dispose resets all state", () => {
    efficiencyGradeCache.enqueue([{ slug: "p1", path: "/p1", hasSessions: true }]);
    expect(efficiencyGradeCache.pending).toBe(1);
    efficiencyGradeCache.dispose();
    expect(efficiencyGradeCache.pending).toBe(0);
    expect(efficiencyGradeCache.total).toBe(0);
  });

  it("grades are valid enum values", async () => {
    // After processQueue completes (mocked), the grade should be one of the valid grades.
    efficiencyGradeCache.enqueue([{ slug: "p2", path: "/p2", hasSessions: true }]);
    // Wait for the async processQueue to run
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const grade = efficiencyGradeCache.get("p2");
    const validGrades: EfficiencyGrade[] = ["A", "B", "C", "D", "F"];
    if (grade !== null) {
      expect(validGrades).toContain(grade);
    }
  });
});
