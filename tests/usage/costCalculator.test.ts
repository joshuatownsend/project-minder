import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeTurnCost,
  getModelPricing,
  getModelMaxContextTokens,
  applyPricing,
  _resetForTesting,
  type TokenCounts,
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

// Opus 4.5 and later — $5/MTok. Opus 4/4.1/3 — $15/MTok.
const OPUS_MODERN_INPUT = 0.000005;
const OPUS_LEGACY_INPUT = 0.000015;

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
    it("claude-opus-4-6-20250514 resolves to the modern $5 Opus rate", () => {
      // Opus 4.5 and later cost $5/MTok, not the $15 the Opus 4/4.1 generation
      // did. This assertion previously expected $15 — the progressive-shortening
      // loop walked `claude-opus-4-6` down to the `claude-opus-4` key and billed
      // a modern Opus turn at triple its real rate.
      const pricing = getModelPricing("claude-opus-4-6-20250514");
      expect(pricing.inputCostPerToken).toBe(OPUS_MODERN_INPUT);
    });

    it("claude-sonnet-4-5-20250514 resolves to sonnet pricing", () => {
      const pricing = getModelPricing("claude-sonnet-4-5-20250514");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
    });

    it("strips date suffix before trying prefix fallback", () => {
      // "claude-sonnet-4-5-20250514" → strip date → "claude-sonnet-4-5" → sonnet
      const pricing = getModelPricing("claude-sonnet-4-5-20250514");
      expect(pricing.outputCostPerToken).toBe(SONNET_OUTPUT);
    });
  });

  describe("getModelPricing generation resolution", () => {
    // The nesting hazard this table exists to prevent: every modern Opus id
    // CONTAINS the substring "opus-4", which is a real key for the older
    // $15/$75 generation. Matching has to pin the specific generation first.
    it.each([
      ["claude-opus-5", OPUS_MODERN_INPUT],
      ["claude-opus-4-8", OPUS_MODERN_INPUT],
      ["claude-opus-4-7", OPUS_MODERN_INPUT],
      ["claude-opus-4-6", OPUS_MODERN_INPUT],
      ["claude-opus-4-5", OPUS_MODERN_INPUT],
      ["claude-opus-4-5-20251101", OPUS_MODERN_INPUT],
    ])("%s bills at the modern $5 Opus rate", (model, expected) => {
      expect(getModelPricing(model).inputCostPerToken).toBe(expected);
    });

    it.each([
      ["claude-opus-4-1-20250805", OPUS_LEGACY_INPUT],
      ["claude-opus-4-20250514", OPUS_LEGACY_INPUT],
      ["claude-3-opus-20240229", OPUS_LEGACY_INPUT],
    ])("%s still bills at the legacy $15 Opus rate", (model, expected) => {
      expect(getModelPricing(model).inputCostPerToken).toBe(expected);
    });

    it("claude-fable-5 bills at its own $10 tier, not an Opus rate", () => {
      const pricing = getModelPricing("claude-fable-5");
      expect(pricing.inputCostPerToken).toBe(0.00001);
      expect(pricing.outputCostPerToken).toBe(0.00005);
    });

    it("every Sonnet generation shares the $3 rate", () => {
      for (const id of [
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5",
        "claude-3-7-sonnet-20250219",
      ]) {
        expect(getModelPricing(id).inputCostPerToken, id).toBe(SONNET_INPUT);
      }
    });

    it("claude-haiku-4-5 bills at $1, distinct from Haiku 3.5's $0.80", () => {
      expect(getModelPricing("claude-haiku-4-5").inputCostPerToken).toBe(0.000001);
      expect(getModelPricing("claude-3-5-haiku-20241022").inputCostPerToken).toBe(0.0000008);
    });
  });

  describe("getModelPricing keyword match", () => {
    it("an unversioned opus id inherits the NEWEST known Opus rate", () => {
      // Previously fell to the oldest ($15). A future `claude-opus-6` should
      // inherit today's rates, not those of a retired generation.
      expect(getModelPricing("some-new-opus-model").inputCostPerToken).toBe(OPUS_MODERN_INPUT);
    });

    it("fancy-haiku-v2 inherits the newest known Haiku rate", () => {
      expect(getModelPricing("fancy-haiku-v2").inputCostPerToken).toBe(0.000001);
    });

    it("new-sonnet-experimental matches sonnet pricing by keyword", () => {
      const pricing = getModelPricing("new-sonnet-experimental");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
    });
  });

  describe("getModelPricing default fallback", () => {
    it("an unrecognized Claude-family id falls back to sonnet pricing", () => {
      // No opus/sonnet/haiku keyword and not in any map, but recognizably
      // Claude — Sonnet is a reasonable same-family approximation.
      const pricing = getModelPricing("claude-experimental-zzz");
      expect(pricing.inputCostPerToken).toBe(SONNET_INPUT);
      expect(pricing.outputCostPerToken).toBe(SONNET_OUTPUT);
    });

    it("an unknown non-Claude id returns zero (unknown) pricing, NOT Claude rates", () => {
      // The offline fallback map is Claude-only, so these ids reach step 4b.
      // They must be priced as unknown ($0), not silently billed at Sonnet.
      for (const id of [
        "gpt-5-turbo",
        "gemini-3.0-pro",
        "o4-mini",
        "totally-unknown-model-xyz",
      ]) {
        const pricing = getModelPricing(id);
        expect(pricing.inputCostPerToken, id).toBe(0);
        expect(pricing.outputCostPerToken, id).toBe(0);
        expect(pricing.cacheWriteCostPerToken, id).toBe(0);
        expect(pricing.cacheReadCostPerToken, id).toBe(0);
      }
    });

    it("an unknown non-Claude turn produces zero cost (not a fabricated Claude-rate cost)", async () => {
      const turn = makeTurn({ model: "gpt-5-turbo", inputTokens: 1000, outputTokens: 500 });
      const cost = await computeTurnCost(turn);
      expect(cost).toBe(0);
    });

    it("the empty-string model sentinel keeps Sonnet pricing (Claude file-parse 'unknown' bucket)", () => {
      // claudeConversations.ts maps its per-model "unknown" bucket to
      // getModelPricing("") and expects the Sonnet estimate. The non-Claude
      // zero fallback must NOT capture this Claude sentinel, or cache-hit
      // Claude files would report $0. Whitespace-only behaves the same.
      for (const sentinel of ["", "   "]) {
        const pricing = getModelPricing(sentinel);
        expect(pricing.inputCostPerToken, JSON.stringify(sentinel)).toBe(SONNET_INPUT);
        expect(pricing.outputCostPerToken, JSON.stringify(sentinel)).toBe(SONNET_OUTPUT);
      }
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

  describe("cache-write TTL split", () => {
    // Opus 5: base $5, 5-minute writes $6.25, 1-hour writes $10 per MTok.
    const OPUS_WRITE_5M = 0.00000625;
    const OPUS_WRITE_1H = 0.00001;

    const tokens = (over: Partial<TokenCounts> = {}): TokenCounts => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      ...over,
    });

    it("bills 1-hour writes at 2x base, not the 1.25x 5-minute rate", () => {
      const pricing = getModelPricing("claude-opus-5");
      const cost = applyPricing(
        pricing,
        tokens({ cacheCreateTokens: 1000, cacheCreate1hTokens: 1000 })
      );
      expect(cost).toBeCloseTo(1000 * OPUS_WRITE_1H, 12);
      // The bug this fixes: the same tokens priced entirely at the 5m rate.
      expect(cost).toBeGreaterThan(1000 * OPUS_WRITE_5M);
    });

    it("splits a mixed turn across both rates", () => {
      const pricing = getModelPricing("claude-opus-5");
      const cost = applyPricing(
        pricing,
        tokens({ cacheCreateTokens: 1000, cacheCreate1hTokens: 400 })
      );
      expect(cost).toBeCloseTo(600 * OPUS_WRITE_5M + 400 * OPUS_WRITE_1H, 12);
    });

    it("omitting the split prices the whole total at the 5-minute rate (pre-split behaviour)", () => {
      const pricing = getModelPricing("claude-opus-5");
      const cost = applyPricing(pricing, tokens({ cacheCreateTokens: 1000 }));
      expect(cost).toBeCloseTo(1000 * OPUS_WRITE_5M, 12);
    });

    it("treats an explicit zero the same as no 1-hour writes", () => {
      const pricing = getModelPricing("claude-opus-5");
      const cost = applyPricing(
        pricing,
        tokens({ cacheCreateTokens: 1000, cacheCreate1hTokens: 0 })
      );
      expect(cost).toBeCloseTo(1000 * OPUS_WRITE_5M, 12);
    });

    it("clamps a 1-hour count that exceeds the total instead of overbilling", () => {
      const pricing = getModelPricing("claude-opus-5");
      const cost = applyPricing(
        pricing,
        tokens({ cacheCreateTokens: 100, cacheCreate1hTokens: 999_999 })
      );
      expect(cost).toBeCloseTo(100 * OPUS_WRITE_1H, 12);
    });

    it("falls back to the flat write rate for a model with no 1-hour rate", () => {
      const flat = {
        inputCostPerToken: 0,
        outputCostPerToken: 0,
        cacheWriteCostPerToken: 0.000002,
        cacheReadCostPerToken: 0,
      };
      const cost = applyPricing(
        flat,
        tokens({ cacheCreateTokens: 1000, cacheCreate1hTokens: 1000 })
      );
      expect(cost).toBeCloseTo(1000 * 0.000002, 12);
    });

    it("computeTurnCost carries the split from a UsageTurn", async () => {
      const turn = makeTurn({
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 1000,
        cacheCreate1hTokens: 1000,
        cacheReadTokens: 0,
      });
      expect(await computeTurnCost(turn)).toBeCloseTo(1000 * OPUS_WRITE_1H, 12);
    });
  });

  describe("long-context tier selection", () => {
    // A model that publishes above-200k rates: 2x input, 1.5x output.
    const tiered = {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheWriteCostPerToken: 0,
      cacheReadCostPerToken: 0,
      inputCostPerTokenAbove200k: 0.000006,
      outputCostPerTokenAbove200k: 0.0000225,
    };

    const counts = (inputTokens: number, outputTokens = 1000): TokenCounts => ({
      inputTokens,
      outputTokens,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });

    it("auto (the default) picks the tier from a single request's prompt size", () => {
      const small = applyPricing(tiered, counts(100_000));
      expect(small).toBeCloseTo(100_000 * 0.000003 + 1000 * 0.000015, 12);

      const large = applyPricing(tiered, counts(250_000));
      expect(large).toBeCloseTo(250_000 * 0.000006 + 1000 * 0.0000225, 12);
    });

    it("an explicit tier overrides what the token count would imply", () => {
      // The regression this guards: a bucket that SUMS many ordinary turns has
      // a huge combined input, but every request in it was billed base-tier.
      // Inferring from the sum would silently upcharge the whole bucket.
      const summed = counts(5_000_000, 200_000);
      const asAggregate = applyPricing(tiered, summed, "base");
      expect(asAggregate).toBeCloseTo(
        5_000_000 * 0.000003 + 200_000 * 0.000015,
        12
      );
      expect(asAggregate).toBeLessThan(applyPricing(tiered, summed));
    });

    it("forces the long tier even for a bucket below the boundary", () => {
      // The mirror case: genuinely-long turns summed into a small-looking
      // bucket must not fall back to base rates.
      const cost = applyPricing(tiered, counts(10_000, 500), "long");
      expect(cost).toBeCloseTo(10_000 * 0.000006 + 500 * 0.0000225, 12);
    });

    it("ignores a forced long tier when the model publishes no above-200k rates", () => {
      const flat = {
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheWriteCostPerToken: 0,
        cacheReadCostPerToken: 0,
      };
      expect(applyPricing(flat, counts(10_000, 500), "long")).toBeCloseTo(
        10_000 * 0.000003 + 500 * 0.000015,
        12
      );
    });

    it("prices an empty bucket at zero in every tier", () => {
      for (const tier of ["auto", "base", "long"] as const) {
        expect(applyPricing(tiered, counts(0, 0), tier)).toBe(0);
      }
    });
  });

  describe("getModelMaxContextTokens", () => {
    it.each([
      ["claude-opus-5", 1_000_000],
      ["claude-opus-4-8", 1_000_000],
      ["claude-opus-4-7", 1_000_000],
      ["claude-opus-4-6", 1_000_000],
      ["claude-sonnet-5", 1_000_000],
      ["claude-sonnet-4-6", 1_000_000],
      ["claude-fable-5", 1_000_000],
    ])("%s reports the 1M window", (model, expected) => {
      expect(getModelMaxContextTokens(model)).toBe(expected);
    });

    it.each([
      // 4.6 is the cutoff: everything from Claude 4.6 on ships 1M by default.
      ["claude-opus-4-5", 200_000],
      ["claude-opus-4-20250514", 200_000],
      ["claude-sonnet-4-5-20250929", 200_000],
      ["claude-haiku-4-5", 200_000],
    ])("%s reports the 200k window", (model, expected) => {
      expect(getModelMaxContextTokens(model)).toBe(expected);
    });

    it("honours LiteLLM's explicit 1M-variant suffixes", () => {
      expect(getModelMaxContextTokens("claude-sonnet-4-5[1m]")).toBe(1_000_000);
      expect(getModelMaxContextTokens("claude-sonnet-4-5:1m")).toBe(1_000_000);
    });

    it("falls back to 200k for an unrecognised id", () => {
      expect(getModelMaxContextTokens("totally-unknown-model")).toBe(200_000);
    });
  });
});
