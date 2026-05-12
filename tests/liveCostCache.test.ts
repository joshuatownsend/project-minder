import { describe, it, expect, vi, beforeEach } from "vitest";

// Must mock before importing the module under test
vi.mock("fs", () => ({
  promises: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/usage/sessionPath", () => ({
  resolveSessionJsonl: vi.fn(),
  isValidSessionId: vi.fn(() => true),
}));

vi.mock("@/lib/usage/parser", () => ({
  parseSessionTurns: vi.fn(),
}));

vi.mock("@/lib/usage/costCalculator", () => ({
  loadPricing: vi.fn().mockResolvedValue(undefined),
  getModelPricing: vi.fn(() => ({
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  })),
  applyPricing: vi.fn(
    (pricing: { inputCostPerToken: number; outputCostPerToken: number; cacheWriteCostPerToken: number; cacheReadCostPerToken: number },
     tokens: { inputTokens: number; outputTokens: number; cacheCreateTokens: number; cacheReadTokens: number }) =>
      tokens.inputTokens * pricing.inputCostPerToken +
      tokens.outputTokens * pricing.outputCostPerToken +
      tokens.cacheCreateTokens * pricing.cacheWriteCostPerToken +
      tokens.cacheReadTokens * pricing.cacheReadCostPerToken
  ),
  getModelMaxContextTokens: vi.fn(() => 200_000),
}));

import { promises as fs } from "fs";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { parseSessionTurns } from "@/lib/usage/parser";
import { getLiveSessionMetrics, _resetLiveMetricsCacheForTesting } from "@/lib/agentView/liveCostCache";

const mockStat = vi.mocked(fs.stat);
const mockResolve = vi.mocked(resolveSessionJsonl);
const mockParseTurns = vi.mocked(parseSessionTurns);

function makeTurn(opts: {
  role?: "assistant" | "user";
  inputTokens?: number;
  outputTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
  model?: string;
}) {
  return {
    sessionId: "s1",
    projectSlug: "test",
    projectDirName: "test",
    timestamp: "2026-01-01T00:00:00Z",
    role: opts.role ?? "assistant",
    model: opts.model ?? "claude-sonnet-4",
    inputTokens: opts.inputTokens ?? 1000,
    outputTokens: opts.outputTokens ?? 500,
    cacheCreateTokens: opts.cacheCreateTokens ?? 0,
    cacheReadTokens: opts.cacheReadTokens ?? 0,
    toolCalls: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLiveMetricsCacheForTesting();
  mockResolve.mockResolvedValue({ filePath: "/tmp/s1.jsonl", projectDirName: "test-dir" });
  mockStat.mockResolvedValue({ mtimeMs: 1000 } as ReturnType<typeof fs.stat> extends Promise<infer T> ? T : never);
});

describe("getLiveSessionMetrics", () => {
  it("returns null when session file cannot be resolved", async () => {
    mockResolve.mockResolvedValue(null);
    const result = await getLiveSessionMetrics("s1");
    expect(result).toBeNull();
  });

  it("returns null when stat fails (file deleted mid-run)", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const result = await getLiveSessionMetrics("s1");
    expect(result).toBeNull();
  });

  it("returns zero cost and zero fill when there are no turns", async () => {
    mockParseTurns.mockResolvedValue([]);
    const result = await getLiveSessionMetrics("s1");
    expect(result).toEqual({ totalCostUsd: 0, maxContextFill: 0 });
  });

  it("sums cost across all assistant turns", async () => {
    mockParseTurns.mockResolvedValue([
      makeTurn({ inputTokens: 1000, outputTokens: 500 }),
      makeTurn({ inputTokens: 2000, outputTokens: 1000 }),
    ] as ReturnType<typeof parseSessionTurns> extends Promise<infer T> ? T : never);

    const result = await getLiveSessionMetrics("s1");
    // Cost for turn 1: 1000*0.000003 + 500*0.000015 = 0.003 + 0.0075 = 0.0105
    // Cost for turn 2: 2000*0.000003 + 1000*0.000015 = 0.006 + 0.015 = 0.021
    expect(result?.totalCostUsd).toBeCloseTo(0.0315, 6);
  });

  it("skips user turns when computing cost", async () => {
    mockParseTurns.mockResolvedValue([
      makeTurn({ role: "user", inputTokens: 99999, outputTokens: 99999 }),
      makeTurn({ role: "assistant", inputTokens: 1000, outputTokens: 500 }),
    ] as ReturnType<typeof parseSessionTurns> extends Promise<infer T> ? T : never);

    const result = await getLiveSessionMetrics("s1");
    expect(result?.totalCostUsd).toBeCloseTo(0.0105, 6);
  });

  it("maxContextFill reflects the last turn, not the historical peak (post-compact accuracy)", async () => {
    mockParseTurns.mockResolvedValue([
      makeTurn({ inputTokens: 100_000 }),   // 50% fill
      makeTurn({ inputTokens: 180_000 }),   // 90% fill (historical peak)
      makeTurn({ inputTokens: 120_000 }),   // 60% fill — most recent after a /compact
    ] as ReturnType<typeof parseSessionTurns> extends Promise<infer T> ? T : never);

    const result = await getLiveSessionMetrics("s1");
    // Should show current state (60%), not the historical peak (90%)
    expect(result?.maxContextFill).toBeCloseTo(0.6, 5);
  });

  it("returns cached result when mtime unchanged", async () => {
    mockParseTurns.mockResolvedValue([makeTurn({ inputTokens: 1000 })] as ReturnType<typeof parseSessionTurns> extends Promise<infer T> ? T : never);
    await getLiveSessionMetrics("s1");
    await getLiveSessionMetrics("s1");
    expect(mockParseTurns).toHaveBeenCalledTimes(1);
  });

  it("re-parses when mtime changes", async () => {
    mockParseTurns.mockResolvedValue([makeTurn({ inputTokens: 1000 })] as ReturnType<typeof parseSessionTurns> extends Promise<infer T> ? T : never);
    await getLiveSessionMetrics("s1");
    mockStat.mockResolvedValue({ mtimeMs: 2000 } as ReturnType<typeof fs.stat> extends Promise<infer T> ? T : never);
    await getLiveSessionMetrics("s1");
    expect(mockParseTurns).toHaveBeenCalledTimes(2);
  });
});
