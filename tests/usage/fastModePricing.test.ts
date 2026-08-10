import { describe, it, expect, afterEach } from "vitest";
import {
  getModelPricing,
  computeTurnCostSync,
  setPricingRules,
} from "@/lib/usage/costCalculator";
import type { UsageTurn } from "@/lib/usage/types";

/**
 * Fast mode pricing — `message.usage.speed === "fast"`.
 *
 * Fast mode bills at double. Anthropic's pricing page (checked 2026-08-10):
 *
 *   "Fast mode, in research preview, provides significantly faster output for
 *    Claude Opus 5 and Claude Opus 4.8 at premium pricing. […] $10 / MTok
 *    input, $50 / MTok output. […] Fast mode pricing applies across the full
 *    context window, including requests over 200k input tokens. […] Prompt
 *    caching multipliers apply on top of fast mode pricing. […] Fast mode is
 *    not available on Claude Opus 4.7 (requests with speed: "fast" return an
 *    error) or Claude Opus 4.6 (requests run at standard speed and are billed
 *    at standard rates)."
 *
 * **This is built against a synthetic fixture on purpose.** Across the local
 * corpus — 1,200 transcripts, 10,742 assistant turns — `speed` was `standard`
 * or `null` and *never* `fast`, so there is nothing real to validate against
 * and no present-day cost being mis-stated. It is built now because the day a
 * fast turn does appear, the error is a silent 2x on the most expensive model
 * in the table, and nothing in the UI would look wrong.
 */

const FAST = "claude-opus-5";
const FAST_DATED = "claude-opus-5-20251101";
const FAST_48 = "claude-opus-4-8";
/** Fast-capable family member that nonetheless bills standard at the provider. */
const NOT_FAST_46 = "claude-opus-4-6";
const NOT_FAST_45 = "claude-opus-4-5";

function turn(model: string, speed?: string): UsageTurn {
  return {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    model,
    ...(speed ? { speed } : {}),
  } as UsageTurn;
}

afterEach(() => {
  setPricingRules([]);
});

describe("fast-mode pricing", () => {
  it("bills a fast Opus 5 turn at exactly double the standard turn", () => {
    const standard = computeTurnCostSync(turn(FAST, "standard"));
    const fast = computeTurnCostSync(turn(FAST, "fast"));

    expect(standard).toBeGreaterThan(0);
    expect(fast).toBeCloseTo(standard * 2, 10);
    // Absolute check against the published table, not just the ratio: $10/$50.
    expect(fast).toBeCloseTo(10_000 * 0.00001 + 2_000 * 0.00005, 10);
  });

  it("applies the cache multipliers on top of the fast base rate", () => {
    // read 0.1x, 5m write 1.25x, 1h write 2x — of the $10 fast input rate.
    const p = getModelPricing(FAST, "fast");
    expect(p.cacheReadCostPerToken).toBeCloseTo(0.000001, 12);
    expect(p.cacheWriteCostPerToken).toBeCloseTo(0.0000125, 12);
    expect(p.cacheWrite1hCostPerToken).toBeCloseTo(0.00002, 12);
  });

  it("resolves dated snapshots and Opus 4.8 to the same fast rates", () => {
    const base = getModelPricing(FAST, "fast");
    for (const id of [FAST_DATED, FAST_48]) {
      expect(getModelPricing(id, "fast").inputCostPerToken).toBe(
        base.inputCostPerToken
      );
    }
  });

  it("publishes no above-200k tier for fast mode", () => {
    // "Fast mode pricing applies across the full context window" — a 900k
    // fast request costs the same per token as a 9k one.
    const p = getModelPricing(FAST, "fast");
    expect(p.inputCostPerTokenAbove200k).toBeUndefined();
    expect(p.outputCostPerTokenAbove200k).toBeUndefined();
    expect(p.cacheReadCostPerTokenAbove200k).toBeUndefined();
  });

  it("bills standard on models without a fast tier, even when speed says fast", () => {
    // Opus 4.6 runs standard and bills standard at the provider, so falling
    // through is correct behaviour rather than mere leniency. Opus 4.5 has no
    // fast mode at all. Both share the Opus-5 family key, which is exactly why
    // fast is matched on the raw model id instead.
    for (const id of [NOT_FAST_46, NOT_FAST_45]) {
      expect(computeTurnCostSync(turn(id, "fast"))).toBeCloseTo(
        computeTurnCostSync(turn(id, "standard")),
        10
      );
    }
  });

  it("bills standard when speed is absent or null", () => {
    // A deliberate inversion of the display rule that null never means
    // "standard". Assuming fast on unlabelled turns would fabricate a doubled
    // cost across every transcript written before the field existed.
    const explicit = computeTurnCostSync(turn(FAST, "standard"));
    expect(computeTurnCostSync(turn(FAST))).toBeCloseTo(explicit, 10);
    expect(
      computeTurnCostSync({ ...turn(FAST), speed: undefined } as UsageTurn)
    ).toBeCloseTo(explicit, 10);
  });

  it("still honours a user pricing rule on a fast turn", () => {
    setPricingRules([
      { pattern: "claude-opus-5*", inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    ]);
    const p = getModelPricing(FAST, "fast");
    expect(p.inputCostPerToken).toBeCloseTo(0.000001, 12);
    expect(p.outputCostPerToken).toBeCloseTo(0.000002, 12);
  });
});
