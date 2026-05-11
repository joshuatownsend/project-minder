import { describe, it, expect } from "vitest";
import {
  MEMORY_INDEX_LINE_CAP,
  MEMORY_FILE_LARGE_BYTES,
  MEMORY_TOTAL_BODY_BUDGET_BYTES,
  budgetTone,
} from "@/lib/memory/budget";

// Numerical constants are physics-driven (article-documented limits) so
// we lock them with exact-value asserts -- if a future PR bumps them, the
// test fails loudly and the reviewer has to confirm the change is
// intentional.

describe("memory budget constants", () => {
  it("locks the documented thresholds", () => {
    expect(MEMORY_INDEX_LINE_CAP).toBe(200);
    expect(MEMORY_FILE_LARGE_BYTES).toBe(4096);
    expect(MEMORY_TOTAL_BODY_BUDGET_BYTES).toBe(32 * 1024);
  });
});

describe("budgetTone", () => {
  it("returns 'ok' for values comfortably below 80% of cap", () => {
    expect(budgetTone(0, 200)).toBe("ok");
    expect(budgetTone(100, 200)).toBe("ok");
    expect(budgetTone(159, 200)).toBe("ok");
  });

  it("returns 'warn' at or above 80% of cap", () => {
    expect(budgetTone(160, 200)).toBe("warn");
    expect(budgetTone(180, 200)).toBe("warn");
    expect(budgetTone(189, 200)).toBe("warn");
  });

  it("returns 'alarm' at or above 95% of cap", () => {
    expect(budgetTone(190, 200)).toBe("alarm");
    expect(budgetTone(199, 200)).toBe("alarm");
    expect(budgetTone(200, 200)).toBe("alarm");
    expect(budgetTone(250, 200)).toBe("alarm");
  });

  it("handles non-positive caps defensively", () => {
    expect(budgetTone(100, 0)).toBe("ok");
    expect(budgetTone(100, -1)).toBe("ok");
  });

  it("crosses the 80% boundary at exactly 0.8", () => {
    expect(budgetTone(8, 10)).toBe("warn");
    expect(budgetTone(7, 10)).toBe("ok");
  });

  it("crosses the 95% boundary at exactly 0.95", () => {
    expect(budgetTone(95, 100)).toBe("alarm");
    expect(budgetTone(94, 100)).toBe("warn");
  });
});

