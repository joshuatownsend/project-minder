import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeTurnCost,
  getModelPricing,
  _resetForTesting,
} from "@/lib/usage/costCalculator";
import type { UsageTurn } from "@/lib/usage/types";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.stubGlobal("fetch", vi.fn());

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    projectSlug: "test-project",
    projectDirName: "test-project",
    model: "claude-sonnet-4-5-20250514",
    role: "assistant",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

// Sonnet fallback pricing constants for test assertions
const SONNET_INPUT = 0.000003;
const SONNET_OUTPUT = 0.000015;
const SONNET_CACHE_WRITE = 0.00000375;
const SONNET_CACHE_READ = 0.0000003;

const OPUS_INPUT = 0.000015;

// Import fs promises once at module level for mocking in beforeEach
import { promises as fsMock } from "fs";

beforeEach(() => {
  _resetForTesting();
  // Make stat throw so cache is treated as missing, and fetch fails so fallback is used
  vi.mocked(fsMock.stat).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fsMock.readFile).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
  vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
  vi.mocked(fetch).mockRejectedValue(new Error("Network error"));
});

describe("costCalculator", () => {
  describe("computeTurnCost with fallback pricing", () => {
    it("calculates cost for claude-sonnet-4-5-20250514 using sonnet fallback", async () => {
      const turn = makeTurn({
        model: "claude-sonnet-4-5-20250514",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
      });
      const cost = await computeTurnCost(turn);
      const expected =
        1000 * SONNET_INPUT +
        500 * SONNET_OUTPUT +
        0 * SONNET_CACHE_WRITE +
        0 * SONNET_CACHE_READ;
      expect(cost).toBeCloseTo(expected, 10);
    });

    it("includes cache tokens in cost calculation", async () => {
      const turn = makeTurn({
        model: "claude-sonnet-4",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 200,
        cacheReadTokens: 300,
      });
      const cost = await computeTurnCost(turn);
      const expected =
        1000 * SONNET_INPUT +
        500 * SONNET_OUTPUT +
        200 * SONNET_CACHE_WRITE +
        300 * SONNET_CACHE_READ;
      expect(cost).toBeCloseTo(expected, 10);
    });
  });

  describe("getModelPricing fuzzy match", () => {
    it("claude-opus-4-6-20250514 resolves to opus pricing", () => {
      const pricing = getModelPricing("claude-opus-4-6-20250514");
      expect(pricing.inputCostPerToken).toBe(OPUS_INPUT);
    });

    it("claude-sonnet-4-5-20250514 resolves to sonnet pricing", () => {
      const pricing = getModelPricing("claude-sonnet-4-5-20250514");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
    });

    it("strips date suffix before trying prefix fallback", () => {
      // "claude-sonnet-4-5-20250514" → strip date → "claude-sonnet-4-5" → "claude-sonnet-4" → match
      const pricing = getModelPricing("claude-sonnet-4-5-20250514");
      expect(pricing.outputCostPerToken).toBe(SONNET_OUTPUT);
    });
  });

  describe("getModelPricing keyword match", () => {
    it("some-new-opus-model matches opus pricing by keyword", () => {
      const pricing = getModelPricing("some-new-opus-model");
      expect(pricing.inputCostPerToken).toBe(OPUS_INPUT);
    });

    it("fancy-haiku-v2 matches haiku pricing by keyword", () => {
      const pricing = getModelPricing("fancy-haiku-v2");
      expect(pricing.inputCostPerToken).toBe(0.0000008);
    });

    it("new-sonnet-experimental matches sonnet pricing by keyword", () => {
      const pricing = getModelPricing("new-sonnet-experimental");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
    });
  });

  describe("getModelPricing default fallback", () => {
    it("completely unknown model returns sonnet pricing", () => {
      const pricing = getModelPricing("totally-unknown-model-xyz");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
      expect(pricing.outputCostPerToken).toBe(SONNET_OUTPUT);
    });
  });

  describe("computeTurnCost dollar amount", () => {
    it("1000 input + 500 output at sonnet rates produces correct dollar amount", async () => {
      const turn = makeTurn({
        model: "claude-sonnet-4",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
      });
      const cost = await computeTurnCost(turn);
      // $0.000003 * 1000 + $0.000015 * 500 = $0.003 + $0.0075 = $0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it("zero tokens produces zero cost", async () => {
      const turn = makeTurn({
        model: "claude-sonnet-4",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
      });
      const cost = await computeTurnCost(turn);
      expect(cost).toBe(0);
    });
  });
});
