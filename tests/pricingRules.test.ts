import { describe, it, expect } from "vitest";
import { matchPricingRule, applyPricingOverlay } from "@/lib/usage/pricingRules";
import type { PricingRule } from "@/lib/types";
import type { ModelPricing } from "@/lib/usage/types";

const BASE: ModelPricing = {
  inputCostPerToken: 0.000003,
  outputCostPerToken: 0.000015,
  cacheWriteCostPerToken: 0.00000375,
  cacheReadCostPerToken: 0.0000003,
};

describe("matchPricingRule", () => {
  it("returns null for empty rules", () => {
    expect(matchPricingRule([], "claude-sonnet-4-6")).toBeNull();
  });

  it("matches exact model name", () => {
    const rules: PricingRule[] = [{ pattern: "claude-sonnet-4-6", inputUsdPerMillion: 5 }];
    expect(matchPricingRule(rules, "claude-sonnet-4-6")?.inputUsdPerMillion).toBe(5);
  });

  it("matches with * wildcard", () => {
    const rules: PricingRule[] = [{ pattern: "claude-opus-4*", outputUsdPerMillion: 90 }];
    expect(matchPricingRule(rules, "claude-opus-4-7")?.outputUsdPerMillion).toBe(90);
    expect(matchPricingRule(rules, "claude-opus-4-20250514")?.outputUsdPerMillion).toBe(90);
  });

  it("matches leading wildcard *haiku*", () => {
    const rules: PricingRule[] = [{ pattern: "*haiku*", inputUsdPerMillion: 1 }];
    expect(matchPricingRule(rules, "claude-haiku-3.5")?.inputUsdPerMillion).toBe(1);
    expect(matchPricingRule(rules, "claude-haiku-3-5-20251001")?.inputUsdPerMillion).toBe(1);
  });

  it("returns null when no pattern matches", () => {
    const rules: PricingRule[] = [{ pattern: "claude-opus-4*" }];
    expect(matchPricingRule(rules, "claude-sonnet-4-6")).toBeNull();
  });

  it("picks longest pattern when multiple match", () => {
    const rules: PricingRule[] = [
      { pattern: "claude-opus-4*",    inputUsdPerMillion: 10 },
      { pattern: "claude-opus-4-7",   inputUsdPerMillion: 20 },
      { pattern: "claude*",            inputUsdPerMillion: 1 },
    ];
    expect(matchPricingRule(rules, "claude-opus-4-7")?.inputUsdPerMillion).toBe(20);
  });

  it("does not match partial prefix without wildcard", () => {
    const rules: PricingRule[] = [{ pattern: "claude-opus" }];
    expect(matchPricingRule(rules, "claude-opus-4-7")).toBeNull();
  });

  it("escapes regex special chars in patterns", () => {
    const rules: PricingRule[] = [{ pattern: "claude.opus*", inputUsdPerMillion: 5 }];
    // "claude.opus" with literal dot should NOT match "claude-opus-4"
    expect(matchPricingRule(rules, "claude-opus-4")).toBeNull();
    expect(matchPricingRule(rules, "claude.opus.4")).not.toBeNull();
  });
});

describe("applyPricingOverlay", () => {
  it("returns base unchanged when rule is null", () => {
    expect(applyPricingOverlay(BASE, null)).toEqual(BASE);
  });

  it("overrides only the fields specified in the rule", () => {
    const rule: PricingRule = { pattern: "*", inputUsdPerMillion: 10 };
    const result = applyPricingOverlay(BASE, rule);
    expect(result.inputCostPerToken).toBeCloseTo(10 / 1_000_000);
    expect(result.outputCostPerToken).toBe(BASE.outputCostPerToken);
    expect(result.cacheWriteCostPerToken).toBe(BASE.cacheWriteCostPerToken);
    expect(result.cacheReadCostPerToken).toBe(BASE.cacheReadCostPerToken);
  });

  it("converts per-million rates to per-token correctly", () => {
    const rule: PricingRule = {
      pattern: "*",
      inputUsdPerMillion: 15,
      outputUsdPerMillion: 75,
      cacheReadUsdPerMillion: 1.5,
      cacheCreateUsdPerMillion: 18.75,
    };
    const result = applyPricingOverlay(BASE, rule);
    expect(result.inputCostPerToken).toBeCloseTo(0.000015);
    expect(result.outputCostPerToken).toBeCloseTo(0.000075);
    expect(result.cacheReadCostPerToken).toBeCloseTo(0.0000015);
    expect(result.cacheWriteCostPerToken).toBeCloseTo(0.00001875);
  });

  describe("optional rates a rule cannot express", () => {
    // Regression: the overlay used to build a fresh 4-field object, so any user
    // with a single pricing rule silently lost long-context (>200k) pricing.
    const TIERED: ModelPricing = {
      ...BASE,
      cacheWrite1hCostPerToken: 0.000006,
      inputCostPerTokenAbove200k: 0.000006,
      outputCostPerTokenAbove200k: 0.0000225,
    };

    it("carries the >200k tiered rates through an overlay that does not touch them", () => {
      // The #375 regression proper: a rule expressing only a cache-read price
      // must not wipe rates it has no opinion about.
      const rule: PricingRule = { pattern: "*", cacheReadUsdPerMillion: 0.5 };
      const result = applyPricingOverlay(TIERED, rule);
      expect(result.inputCostPerTokenAbove200k).toBe(TIERED.inputCostPerTokenAbove200k);
      expect(result.outputCostPerTokenAbove200k).toBe(TIERED.outputCostPerTokenAbove200k);
    });

    it("scales the >200k input rate with an input override, keeping the tier's shape", () => {
      // Supersedes the original "preserve verbatim" assertion from #375. That
      // fixed the rates being DROPPED, which was the live bug; preserving them
      // unchanged is wrong for a different reason. A rule setting $10/MTok on a
      // $3/MTok model is saying "input costs me $10" — leaving the above-200k
      // rate at the provider's $6 would apply the override to short prompts
      // only, and leave the "override" costing less above 200k than below it.
      //
      // Same argument the 1-hour cache-write branch already makes. It only
      // became reachable when #376 gave the fallback table its first model with
      // tiered rates.
      const rule: PricingRule = { pattern: "*", inputUsdPerMillion: 10 };
      const result = applyPricingOverlay(TIERED, rule);
      expect(result.inputCostPerToken).toBeCloseTo(0.00001, 12);
      // 2x the base rate before the override; 2x after it.
      expect(result.inputCostPerTokenAbove200k).toBeCloseTo(0.00002, 12);
      expect(result.inputCostPerTokenAbove200k!).toBeGreaterThan(result.inputCostPerToken);
      // Untouched by an input-only rule.
      expect(result.outputCostPerTokenAbove200k).toBe(TIERED.outputCostPerTokenAbove200k);
    });

    it("preserves the 1-hour cache-write rate when the rule does not touch cache writes", () => {
      const rule: PricingRule = { pattern: "*", inputUsdPerMillion: 10 };
      expect(applyPricingOverlay(TIERED, rule).cacheWrite1hCostPerToken).toBe(
        TIERED.cacheWrite1hCostPerToken
      );
    });

    it("scales the 1-hour rate with a cache-write override, keeping the 5m:1h ratio", () => {
      // BASE 5m is 0.00000375 and 1h is 0.000006 — a 1.6x ratio. Overriding the
      // write rate to $7.50/MTok should carry that ratio, not leave 1-hour
      // writes at the provider's untouched price.
      const rule: PricingRule = { pattern: "*", cacheCreateUsdPerMillion: 7.5 };
      const result = applyPricingOverlay(TIERED, rule);
      expect(result.cacheWriteCostPerToken).toBeCloseTo(0.0000075, 12);
      expect(result.cacheWrite1hCostPerToken).toBeCloseTo(0.0000075 * 1.6, 12);
    });

    it("leaves the 1-hour rate absent when the base has none", () => {
      const rule: PricingRule = { pattern: "*", cacheCreateUsdPerMillion: 7.5 };
      expect(applyPricingOverlay(BASE, rule).cacheWrite1hCostPerToken).toBeUndefined();
    });
  });
});
