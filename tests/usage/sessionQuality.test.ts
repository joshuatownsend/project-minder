import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCacheStats,
  detectCompactionLoops,
  detectToolFailureStreaks,
  computeSessionQuality,
  getModelContextWindow,
  turnContextFill,
  _resetWarnedModelsForTesting,
} from "@/lib/usage/sessionQuality";
import type { UsageTurn } from "@/lib/usage/types";

beforeEach(() => {
  _resetWarnedModelsForTesting();
});

function asTurn(overrides: Partial<UsageTurn> & { role: "user" | "assistant" }): UsageTurn {
  return {
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00Z",
    sessionId: "s1",
    projectSlug: "p",
    projectDirName: "p",
    model: overrides.model ?? "claude-sonnet-4-6",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

function assistant(args: Partial<UsageTurn>): UsageTurn {
  return asTurn({ role: "assistant", ...args });
}

function user(args: Partial<UsageTurn>): UsageTurn {
  return asTurn({ role: "user", ...args });
}

describe("getModelContextWindow", () => {
  it("returns 200K for standard claude-sonnet-4-6", () => {
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });

  it("returns 1M when [1m] suffix is present", () => {
    expect(getModelContextWindow("claude-sonnet-4-7[1m]")).toBe(1_000_000);
  });

  it("returns 200K for opus and haiku families", () => {
    expect(getModelContextWindow("claude-opus-4-7")).toBe(200_000);
    expect(getModelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("returns 100K for legacy claude-2 family", () => {
    expect(getModelContextWindow("claude-2.1")).toBe(100_000);
  });

  it("falls back to 200K and warns once for unknown models", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(getModelContextWindow("gpt-5")).toBe(200_000);
      expect(getModelContextWindow("gpt-5")).toBe(200_000);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("returns the default for empty model string without warning", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(getModelContextWindow("")).toBe(200_000);
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("computeCacheStats", () => {
  it("returns null hit ratio when no cache activity exists", () => {
    const turns = [assistant({ inputTokens: 100, outputTokens: 50 })];
    const stats = computeCacheStats(turns);
    expect(stats.hitRatio).toBeNull();
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.cacheCreateTokens).toBe(0);
  });

  it("computes ratio across assistant turns and ignores user turns", () => {
    const turns = [
      assistant({ cacheReadTokens: 0, cacheCreateTokens: 1000 }),
      user({ toolResultText: "ok" }),
      assistant({ cacheReadTokens: 700, cacheCreateTokens: 0 }),
    ];
    const stats = computeCacheStats(turns);
    // 700 / (700 + 1000) = ~0.4118
    expect(stats.hitRatio).toBeCloseTo(700 / 1700, 4);
    expect(stats.cacheReadTokens).toBe(700);
    expect(stats.cacheCreateTokens).toBe(1000);
  });

  it("rebuildWasteUsd is positive when build cost exceeds read savings", () => {
    const turns = [
      assistant({ model: "claude-sonnet-4-6", cacheCreateTokens: 1_000_000, cacheReadTokens: 0 }),
    ];
    const stats = computeCacheStats(turns);
    expect(stats.rebuildWasteUsd).toBeGreaterThan(0);
  });

  it("rebuildWasteUsd can be negative when reads paid back the build", () => {
    const turns = [
      assistant({ model: "claude-sonnet-4-6", cacheCreateTokens: 0, cacheReadTokens: 10_000_000 }),
    ];
    const stats = computeCacheStats(turns);
    expect(stats.rebuildWasteUsd).toBeLessThan(0);
  });
});

describe("detectCompactionLoops", () => {
  it("emits no findings on a healthy session with low fill", () => {
    const turns = [
      assistant({ inputTokens: 10_000 }),
      assistant({ inputTokens: 11_000 }),
      assistant({ inputTokens: 12_000 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("detects a loop when consecutive turns sit above 75% fill with low variance", () => {
    // 200K window, 160K = 80% fill. Variance < 10%.
    const turns = [
      assistant({ inputTokens: 160_000 }),
      assistant({ inputTokens: 162_000 }),
      assistant({ inputTokens: 161_000 }),
    ];
    const findings = detectCompactionLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0].pairCount).toBe(2);
    expect(findings[0].peakFill).toBeGreaterThan(0.75);
  });

  it("does not flag high-variance turns as a loop", () => {
    // High fill but variance is huge — Claude IS doing work, not looping.
    const turns = [
      assistant({ inputTokens: 160_000 }),
      assistant({ inputTokens: 100_000 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("requires fill >75% even when variance is low", () => {
    // Steady-state at 50% fill is just steady work, not a loop.
    const turns = [
      assistant({ inputTokens: 100_000 }),
      assistant({ inputTokens: 101_000 }),
      assistant({ inputTokens: 100_500 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("ignores user turns and synthetic-model turns when computing pairs", () => {
    const turns = [
      assistant({ inputTokens: 160_000 }),
      user({ toolResultText: "ok" }),
      assistant({ inputTokens: 162_000 }),
    ];
    const findings = detectCompactionLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0].pairCount).toBe(1);
  });
});

describe("detectToolFailureStreaks", () => {
  it("returns no streaks when fewer than 5 evaluable turns exist", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})), // grace turns
      user({ toolResultText: "Error: foo" }),
      user({ toolResultText: "Error: bar" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("flags 5 consecutive errored tool results past the grace window", () => {
    const turns: UsageTurn[] = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: "Error: nope" }),
      user({ toolResultText: "failed to apply" }),
      user({ toolResultText: "Error: nope" }),
      user({ toolResultText: "not found" }),
      user({ toolResultText: "Error: nope" }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureRate).toBe(1.0);
    expect(streaks[0].windowSize).toBe(5);
  });

  it("respects the first-6-turns grace by skipping early errors", () => {
    const turns = [
      // 6 grace turns, all errored — must not contribute to a streak.
      ...Array.from({ length: 6 }, () => user({ toolResultText: "Error: ignore me" })),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("treats <50% rate as not-a-streak", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: "Error: a" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "Error: b" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("detects errors that appear early in a long, truncated toolResultText", () => {
    // The parser slices toolResultText at 2000 chars; a streak detector that
    // missed errors near the truncation boundary would underreport. The
    // ERROR_MARKER_RE looks for substrings, so coverage of an early-line
    // marker is the realistic guarantee.
    const longBody = "Error: something went wrong\n" + "x".repeat(1900);
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureCount).toBe(5);
  });

  it("counts assistant turns with isError=true alongside user error results", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      assistant({ isError: true }),
      user({ toolResultText: "Error: x" }),
      assistant({ isError: true }),
      user({ toolResultText: "failed" }),
      assistant({ isError: true }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureRate).toBe(1.0);
  });
});

describe("computeSessionQuality + turnContextFill", () => {
  it("turnContextFill returns null for user turns", () => {
    expect(turnContextFill(user({}))).toBeNull();
  });

  it("turnContextFill returns null when input tokens are zero", () => {
    expect(turnContextFill(assistant({ inputTokens: 0 }))).toBeNull();
  });

  it("turnContextFill divides input by the model context window", () => {
    expect(
      turnContextFill(assistant({ model: "claude-sonnet-4-6", inputTokens: 100_000 }))
    ).toBeCloseTo(0.5, 4);
  });

  it("turnContextFill measures uncached input only — cache-aware sessions show low fill", () => {
    // Per TODO #102's spec: a heavily-cached healthy session with
    // 388 input_tokens and 60K cache_read should fill at ~0.2%
    // (just the new tokens this turn). The compaction-loop detector
    // intentionally fires on HIGH input_tokens (cache failing) — see
    // module comment for the rationale.
    expect(
      turnContextFill(
        assistant({
          model: "claude-sonnet-4-6",
          inputTokens: 388,
          cacheReadTokens: 60_000,
          cacheCreateTokens: 0,
        })
      )
    ).toBeCloseTo(388 / 200_000, 4);
  });

  it("detectCompactionLoops fires when input_tokens stays high (cache failing)", () => {
    // High input_tokens (160K) means the model is reading new content
    // every turn — cache isn't working. Three such consecutive turns
    // with low variance signals a real compaction loop.
    const turns = [
      assistant({ inputTokens: 160_000, cacheReadTokens: 0 }),
      assistant({ inputTokens: 161_000, cacheReadTokens: 0 }),
      assistant({ inputTokens: 160_500, cacheReadTokens: 0 }),
    ];
    const findings = computeSessionQuality(turns).compactionLoops;
    expect(findings.length).toBe(1);
    expect(findings[0].peakFill).toBeGreaterThan(0.75);
  });

  it("detectCompactionLoops does NOT fire on healthy heavily-cached sessions", () => {
    // Same total context (~160K loaded) but split as low input_tokens
    // and high cache_read — the cache is doing its job. The loop
    // detector should stay silent.
    const turns = [
      assistant({ inputTokens: 100, cacheReadTokens: 159_000 }),
      assistant({ inputTokens: 100, cacheReadTokens: 161_000 }),
      assistant({ inputTokens: 100, cacheReadTokens: 160_000 }),
    ];
    expect(computeSessionQuality(turns).compactionLoops).toEqual([]);
  });

  it("computeSessionQuality returns the bundled summary in one pass", () => {
    const turns = [
      assistant({ inputTokens: 160_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
      assistant({ inputTokens: 162_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
      assistant({ inputTokens: 161_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
    ];
    const summary = computeSessionQuality(turns);
    expect(summary.cache.hitRatio).toBeCloseTo(0.4118, 3);
    expect(summary.compactionLoops.length).toBe(1);
    expect(summary.toolFailureStreaks).toEqual([]);
    expect(summary.maxContextFill).toBeGreaterThan(0.75);
  });
});
