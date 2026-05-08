import { describe, it, expect } from "vitest";
import { categoryToWorkMode, aggregateWorkMode } from "@/lib/usage/workMode";

describe("categoryToWorkMode", () => {
  it("maps Exploration categories to exploration", () => {
    expect(categoryToWorkMode("Exploration")).toBe("exploration");
    expect(categoryToWorkMode("Brainstorming")).toBe("exploration");
    expect(categoryToWorkMode("Planning")).toBe("exploration");
  });

  it("maps Building categories to building", () => {
    expect(categoryToWorkMode("Coding")).toBe("building");
    expect(categoryToWorkMode("Feature Dev")).toBe("building");
    expect(categoryToWorkMode("Refactoring")).toBe("building");
  });

  it("maps Testing to testing", () => {
    expect(categoryToWorkMode("Testing")).toBe("testing");
  });

  it("maps everything else to other", () => {
    expect(categoryToWorkMode("Git Ops")).toBe("other");
    expect(categoryToWorkMode("Build/Deploy")).toBe("other");
    expect(categoryToWorkMode("Debugging")).toBe("other");
    expect(categoryToWorkMode("Delegation")).toBe("other");
    expect(categoryToWorkMode("Conversation")).toBe("other");
    expect(categoryToWorkMode("General")).toBe("other");
  });
});

describe("aggregateWorkMode", () => {
  it("returns all zeros for empty turns", () => {
    expect(aggregateWorkMode([])).toEqual({ exploration: 0, building: 0, testing: 0, other: 0 });
  });

  it("returns all zeros when no turns have categories", () => {
    expect(aggregateWorkMode([{ category: null }, { category: undefined }]))
      .toEqual({ exploration: 0, building: 0, testing: 0, other: 0 });
  });

  it("computes correct percentages", () => {
    const turns = [
      { category: "Exploration" },
      { category: "Exploration" },
      { category: "Coding" },
      { category: "Testing" },
    ];
    const result = aggregateWorkMode(turns);
    expect(result.exploration).toBe(50);
    expect(result.building).toBe(25);
    expect(result.testing).toBe(25);
    expect(result.other).toBe(0);
  });

  it("handles mixed with nulls (nulls skipped from denominator)", () => {
    const turns = [
      { category: "Coding" },
      { category: null },
      { category: "Coding" },
    ];
    const result = aggregateWorkMode(turns);
    // 2 categorized turns, both Building
    expect(result.building).toBe(100);
    expect(result.exploration).toBe(0);
  });

  it("percentages round to integers", () => {
    // 1/3 ≈ 33%
    const turns = [
      { category: "Exploration" },
      { category: "Coding" },
      { category: "Testing" },
    ];
    const result = aggregateWorkMode(turns);
    expect(result.exploration).toBe(33);
    expect(result.building).toBe(33);
    expect(result.testing).toBe(33);
    expect(result.other).toBe(0);
  });

  it("all 13 categories map without throwing", () => {
    const allCats = [
      "Exploration", "Brainstorming", "Planning",
      "Coding", "Feature Dev", "Refactoring",
      "Testing",
      "Git Ops", "Build/Deploy", "Debugging", "Delegation", "Conversation", "General",
    ];
    const turns = allCats.map((category) => ({ category }));
    expect(() => aggregateWorkMode(turns)).not.toThrow();
  });
});
