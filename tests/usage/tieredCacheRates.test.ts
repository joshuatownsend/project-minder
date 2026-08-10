import { describe, it, expect } from "vitest";
import {
  applyPricing,
  getModelPricing,
  loadPricing,
  selectEffectiveRates,
} from "@/lib/usage/costCalculator";
import type { ModelPricing } from "@/lib/usage/types";

/**
 * Issue #393 — the long-context tier must reach the CACHE rates, not just
 * input and output.
 *
 * `applyPricing` has always selected the tier from the whole prompt
 * (input + cache read + cache create), which is right. But only `inputRate` and
 * `outputRate` switched to the above-200k rates; cache tokens stayed at base.
 * On the requests the tier exists for that is the wrong two-thirds: a real
 * long-context Claude Code turn arrives as ~5k uncached input against ~220k
 * cache read, so ~98% of the prompt was being billed at half rate.
 *
 * ## Why these numbers are trustworthy
 *
 * The Anthropic pricing page no longer publishes a long-context table — the
 * tier only ever applied to the Sonnet 3.5→4.5 lineage, now retired from the
 * first-party API. The rates below were derived from two rules the page does
 * still state: cache multipliers are "relative to base input token rates"
 * (read 0.1x, 5m write 1.25x, 1h write 2x) and "stack with other pricing
 * modifiers". Against Sonnet 4.5's $6/MTok above-200k input that gives
 * $0.60 / $7.50 / $12.00 — exactly LiteLLM's published
 * `*_above_200k_tokens` cache fields. Do not "simplify" these to multiples of
 * the $3 base rate; that is the bug.
 */

// Sonnet 4.5, per token. Base column, then the above-200k column.
const SONNET_45: ModelPricing = {
  inputCostPerToken: 0.000003,
  outputCostPerToken: 0.000015,
  cacheWriteCostPerToken: 0.00000375,
  cacheWrite1hCostPerToken: 0.000006,
  cacheReadCostPerToken: 0.0000003,
  inputCostPerTokenAbove200k: 0.000006,
  outputCostPerTokenAbove200k: 0.0000225,
  cacheReadCostPerTokenAbove200k: 0.0000006,
  cacheWriteCostPerTokenAbove200k: 0.0000075,
  cacheWrite1hCostPerTokenAbove200k: 0.000012,
};

/**
 * The shape that actually occurs: a cache-heavy long-context turn. Input and
 * output are deliberately tiny relative to the cache read, so a fix that only
 * tiered input/output could not pass this test — the assertion is dominated by
 * the cache term.
 */
const CACHE_HEAVY = {
  inputTokens: 5_000,
  outputTokens: 1_000,
  cacheCreateTokens: 0,
  cacheReadTokens: 220_000,
};

describe("long-context tier — cache rates (#393)", () => {
  it("bills cache reads at the above-200k rate on a cache-dominated prompt", () => {
    const cost = applyPricing(SONNET_45, CACHE_HEAVY);

    const expected =
      5_000 * 0.000006 + // input at the long rate
      1_000 * 0.0000225 + // output at the long rate
      220_000 * 0.0000006; // cache read at the long rate — the dominant term
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("is materially more than the pre-fix number, and the gap is the cache term", () => {
    // What the old code produced: tiered input/output, base cache read. Stated
    // as an explicit alternative rather than a magic constant so the test says
    // what the regression would look like if the cache selection were removed.
    const preFix =
      5_000 * 0.000006 + 1_000 * 0.0000225 + 220_000 * 0.0000003;
    const cost = applyPricing(SONNET_45, CACHE_HEAVY);

    expect(cost).toBeGreaterThan(preFix);
    // The cache read doubled, and it is ~2/3 of the bill on this shape.
    expect(cost - preFix).toBeCloseTo(220_000 * 0.0000003, 10);
    expect(cost / preFix).toBeGreaterThan(1.5);
  });

  it("tiers both cache-write TTLs, each at its own above-200k rate", () => {
    const tokens = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreateTokens: 240_000,
      cacheCreate1hTokens: 200_000, // subset: 200k at 1h, 40k at 5m
      cacheReadTokens: 0,
    };
    const cost = applyPricing(SONNET_45, tokens);

    const expected =
      1_000 * 0.000006 +
      500 * 0.0000225 +
      40_000 * 0.0000075 + // 5m writes at the long rate
      200_000 * 0.000012; // 1h writes at the long rate
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("leaves cache rates at base when the prompt is under the boundary", () => {
    const tokens = {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 100_000,
    };
    const cost = applyPricing(SONNET_45, tokens);

    const expected =
      5_000 * 0.000003 + 1_000 * 0.000015 + 100_000 * 0.0000003;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("falls back per-rate: a tiered read rate does not lift untiered write rates", () => {
    // The absence of a tiered write rate has to keep meaning "flat" for THAT
    // rate specifically. A shared fallback would silently promote writes here.
    const partial: ModelPricing = {
      ...SONNET_45,
      cacheWriteCostPerTokenAbove200k: undefined,
      cacheWrite1hCostPerTokenAbove200k: undefined,
    };
    const tokens = {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheCreateTokens: 100_000,
      cacheReadTokens: 150_000,
    };
    const cost = applyPricing(partial, tokens);

    const expected =
      1_000 * 0.000006 + // input tiered
      100_000 * 0.00000375 + // writes stay at base — no tiered rate published
      150_000 * 0.0000006; // read tiered
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("derives the tiered 1-hour write rate when only the 5-minute one is published", async () => {
    // Codex review of #423, round 2. LiteLLM's dated Sonnet 4 entries publish a
    // tiered 5-minute write rate but no tiered 1-hour one. Falling back to the
    // base 1-hour rate mixes a tiered and a base rate inside one request — and
    // Claude Code writes at the 1-hour TTL, so that is the dominant cache
    // component of a long-context turn, not a corner of it.
    await loadPricing();
    const p = getModelPricing("claude-sonnet-4-20250514");
    expect(p.cacheWriteCostPerTokenAbove200k).toBeCloseTo(0.0000075, 12);
    expect(p.cacheWrite1hCostPerTokenAbove200k).toBeUndefined(); // the gap

    const cost = applyPricing(p, {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheCreateTokens: 100_000,
      cacheCreate1hTokens: 100_000,
      cacheReadTokens: 150_000,
    });
    const expected =
      1_000 * 0.000006 +
      100_000 * 0.000012 + // base 1h $6 scaled by the same 2x the 5m rate moved
      150_000 * 0.0000006;
    expect(cost).toBeCloseTo(expected, 10);
    // The pre-fix number: base 1h at $6/MTok.
    expect(cost).not.toBeCloseTo(
      1_000 * 0.000006 + 100_000 * 0.000006 + 150_000 * 0.0000006,
      10,
    );
  });

  it("never prices a 1-hour write below a 5-minute one", async () => {
    // The structural invariant, asserted rather than assumed. A 1-hour write is
    // 2x base input and a 5-minute write 1.25x, so `1h >= 5m` holds for every
    // model at every tier — and the bug above was detectable from this alone,
    // without knowing a single published rate.
    await loadPricing();
    const tokens = {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 250_000, // forces the long tier where one exists
    };
    for (const id of [
      "claude-sonnet-4-20250514",
      "claude-4-sonnet-20250514",
      "claude-sonnet-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
    ]) {
      const rates = selectEffectiveRates(getModelPricing(id), tokens);
      expect(
        rates.cacheWrite1hRate,
        `${id}: 1-hour cache write priced below the 5-minute rate`,
      ).toBeGreaterThanOrEqual(rates.cacheWriteRate);
    }
  });

  it("carries the tiered cache rates through the LiteLLM parser", async () => {
    // The tests above build `ModelPricing` by hand, and the offline-fallback
    // tests in longContextTier never touch the parser — so deleting the three
    // `*_above_200k_tokens` cache fields from `parseLiteLLMEntry` used to pass
    // the entire suite. Found by mutation, which is the only way that gap was
    // ever going to surface. This pins the online/pinned-fixture path.
    await loadPricing();
    const p = getModelPricing("claude-sonnet-4-5");

    expect(p.cacheReadCostPerTokenAbove200k).toBeCloseTo(0.0000006, 12);
    expect(p.cacheWriteCostPerTokenAbove200k).toBeCloseTo(0.0000075, 12);
    expect(p.cacheWrite1hCostPerTokenAbove200k).toBeCloseTo(0.000012, 12);
    // Each is 2x its base counterpart — the tier doubles the input rate, and
    // the cache multipliers ride on top of the tiered rate.
    expect(p.cacheReadCostPerTokenAbove200k!).toBeCloseTo(
      p.cacheReadCostPerToken * 2,
      12,
    );
  });

  it("publishes no tiered cache rates for a flat model, through the parser", async () => {
    await loadPricing();
    const p = getModelPricing("claude-sonnet-5");
    expect(p.cacheReadCostPerTokenAbove200k).toBeUndefined();
    expect(p.cacheWriteCostPerTokenAbove200k).toBeUndefined();
  });

  it("keeps flat cache pricing for a model with no tier at all", () => {
    // Sonnet 5 / Opus 4.6+ include the full 1M window at standard pricing, so a
    // 900k-token request must cost the same per token as a 9k one.
    const flat: ModelPricing = {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheWriteCostPerToken: 0.00000375,
      cacheWrite1hCostPerToken: 0.000006,
      cacheReadCostPerToken: 0.0000003,
    };
    const cost = applyPricing(flat, CACHE_HEAVY);

    const expected =
      5_000 * 0.000003 + 1_000 * 0.000015 + 220_000 * 0.0000003;
    expect(cost).toBeCloseTo(expected, 10);
  });
});
