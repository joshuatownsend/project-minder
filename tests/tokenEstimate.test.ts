import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  bytesToTokens,
  contextWindowPercent,
  estimateTokensFromBytes,
  formatContextWindowPercent,
  formatTokenCount,
  withProjectedContextCost,
} from "@/lib/usage/tokenEstimate";

describe("bytesToTokens", () => {
  it("returns 0 for zero, negative, NaN, and Infinity", () => {
    expect(bytesToTokens(0)).toBe(0);
    expect(bytesToTokens(-100)).toBe(0);
    expect(bytesToTokens(NaN)).toBe(0);
    expect(bytesToTokens(Infinity)).toBe(0);
  });

  it("rounds to nearest integer at the BYTES_PER_TOKEN ratio", () => {
    expect(bytesToTokens(4)).toBe(1);
    expect(bytesToTokens(4_000)).toBe(1_000);
    // 4801 / 4 = 1200.25 → rounds to 1200
    expect(bytesToTokens(4_801)).toBe(1_200);
    // 4802 / 4 = 1200.5 → rounds to 1201
    expect(bytesToTokens(4_802)).toBe(1_201);
  });

  it("agrees with the BYTES_PER_TOKEN constant", () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(bytesToTokens(BYTES_PER_TOKEN * 250)).toBe(250);
  });
});

describe("contextWindowPercent", () => {
  it("returns 0 for non-positive tokens or window", () => {
    expect(contextWindowPercent(0)).toBe(0);
    expect(contextWindowPercent(-50)).toBe(0);
    expect(contextWindowPercent(1_000, 0)).toBe(0);
  });

  it("uses 200k as the default context window", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    // 2000 tokens / 200k = 1%
    expect(contextWindowPercent(2_000)).toBeCloseTo(1, 6);
  });

  it("honors a custom context window", () => {
    expect(contextWindowPercent(1_000, 100_000)).toBeCloseTo(1, 6);
    expect(contextWindowPercent(500_000, 1_000_000)).toBeCloseTo(50, 6);
  });
});

describe("formatTokenCount", () => {
  it("renders sub-1k counts verbatim", () => {
    expect(formatTokenCount(0)).toBe("~0");
    expect(formatTokenCount(7)).toBe("~7");
    expect(formatTokenCount(890)).toBe("~890");
    expect(formatTokenCount(999)).toBe("~999");
  });

  it("renders 1k–100k counts with one decimal of k", () => {
    expect(formatTokenCount(1_000)).toBe("~1.0k");
    expect(formatTokenCount(1_234)).toBe("~1.2k");
    expect(formatTokenCount(12_500)).toBe("~12.5k");
    expect(formatTokenCount(99_900)).toBe("~99.9k");
  });

  it("rounds to whole-k once above 100k", () => {
    expect(formatTokenCount(100_000)).toBe("~100k");
    expect(formatTokenCount(150_456)).toBe("~150k");
    expect(formatTokenCount(199_999)).toBe("~200k");
  });
});

describe("formatContextWindowPercent", () => {
  it("returns '0%' for zero", () => {
    expect(formatContextWindowPercent(0)).toBe("0%");
  });

  it("floors near-zero at '<0.1%' so tiny shares don't read as nothing", () => {
    expect(formatContextWindowPercent(0.001)).toBe("<0.1%");
    expect(formatContextWindowPercent(0.099)).toBe("<0.1%");
  });

  it("renders sub-10% with one decimal", () => {
    expect(formatContextWindowPercent(0.6)).toBe("0.6%");
    expect(formatContextWindowPercent(5.2)).toBe("5.2%");
    expect(formatContextWindowPercent(9.99)).toBe("10.0%");
  });

  it("rounds to whole-percent at >=10%", () => {
    expect(formatContextWindowPercent(10)).toBe("10%");
    expect(formatContextWindowPercent(25.4)).toBe("25%");
    expect(formatContextWindowPercent(99.9)).toBe("100%");
  });
});

describe("estimateTokensFromBytes", () => {
  it("returns null for undefined or non-positive byte counts", () => {
    expect(estimateTokensFromBytes(undefined)).toBeNull();
    expect(estimateTokensFromBytes(0)).toBeNull();
    expect(estimateTokensFromBytes(-1)).toBeNull();
  });

  it("returns null when byte count rounds down to zero tokens", () => {
    // 1 byte / 4 = 0.25 → rounds to 0; chip should be absent, not "~0 · 0%"
    expect(estimateTokensFromBytes(1)).toBeNull();
  });

  it("returns the chip triple for a typical 4.8KB body", () => {
    const est = estimateTokensFromBytes(4_800);
    expect(est).not.toBeNull();
    expect(est!.tokens).toBe(1_200);
    expect(est!.contextWindowPercent).toBeCloseTo(0.6, 6);
    expect(est!.chipLabel).toBe("~1.2k · 0.6%");
  });

  it("collapses tiny shares to '<0.1%' in the chip label", () => {
    // 40 bytes → 10 tokens → 0.005% → '<0.1%'
    const est = estimateTokensFromBytes(40);
    expect(est).not.toBeNull();
    expect(est!.tokens).toBe(10);
    expect(est!.chipLabel).toBe("~10 · <0.1%");
  });

  it("honors a custom context window in the percent leg", () => {
    // 4000 bytes → 1000 tokens → 1% against 100k window
    const est = estimateTokensFromBytes(4_000, 100_000);
    expect(est).not.toBeNull();
    expect(est!.chipLabel).toBe("~1.0k · 1.0%");
  });
});

describe("withProjectedContextCost", () => {
  interface FakeEntry {
    id?: string;
    name?: string;
    fileBytes?: number;
    otherStuff?: { keepMe: boolean };
    projectedContextCost?: { tokenEstimate: number; contextWindowPercent: number };
  }

  it("returns the entry unchanged when fileBytes is missing", () => {
    const entry: FakeEntry = { id: "x", name: "no-bytes" };
    expect(withProjectedContextCost(entry)).toBe(entry);
  });

  it("returns the entry unchanged when fileBytes rounds to zero tokens", () => {
    const entry: FakeEntry = { id: "x", fileBytes: 1 };
    expect(withProjectedContextCost(entry)).toBe(entry);
  });

  it("populates projectedContextCost for a real body", () => {
    const entry: FakeEntry = { id: "x", fileBytes: 4_800 };
    const enriched = withProjectedContextCost(entry);
    expect(enriched).not.toBe(entry);
    expect(enriched.projectedContextCost).toEqual({
      tokenEstimate: 1_200,
      contextWindowPercent: 0.6,
    });
  });

  it("preserves all other fields and is non-mutating", () => {
    const entry: FakeEntry = {
      id: "x",
      name: "thing",
      fileBytes: 4_000,
      otherStuff: { keepMe: true },
    };
    const enriched = withProjectedContextCost(entry);
    expect(enriched.id).toBe("x");
    expect(enriched.name).toBe("thing");
    expect(enriched.otherStuff).toBe(entry.otherStuff);
    // Original entry not mutated
    expect(entry.projectedContextCost).toBeUndefined();
  });

  it("honors a custom context window in the % leg", () => {
    const entry: FakeEntry = { fileBytes: 4_000 };
    const enriched = withProjectedContextCost(entry, 100_000);
    expect(enriched.projectedContextCost?.tokenEstimate).toBe(1_000);
    expect(enriched.projectedContextCost?.contextWindowPercent).toBeCloseTo(1, 6);
  });
});
