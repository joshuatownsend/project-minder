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
});
