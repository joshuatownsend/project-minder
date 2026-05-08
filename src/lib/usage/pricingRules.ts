import type { PricingRule } from "@/lib/types";
import type { ModelPricing } from "@/lib/usage/types";

const regexCache = new Map<string, RegExp>();

function patternToRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    re = new RegExp(`^${escaped}$`, "i");
    regexCache.set(pattern, re);
  }
  return re;
}

export function matchPricingRule(rules: PricingRule[], model: string): PricingRule | null {
  let best: PricingRule | null = null;
  let bestLen = -1;

  for (const rule of rules) {
    if (patternToRegex(rule.pattern).test(model)) {
      if (rule.pattern.length > bestLen) {
        best = rule;
        bestLen = rule.pattern.length;
      }
    }
  }

  return best;
}

export function applyPricingOverlay(
  base: ModelPricing,
  rule: PricingRule | null
): ModelPricing {
  if (!rule) return base;
  return {
    inputCostPerToken: rule.inputUsdPerMillion !== undefined
      ? rule.inputUsdPerMillion / 1_000_000
      : base.inputCostPerToken,
    outputCostPerToken: rule.outputUsdPerMillion !== undefined
      ? rule.outputUsdPerMillion / 1_000_000
      : base.outputCostPerToken,
    cacheReadCostPerToken: rule.cacheReadUsdPerMillion !== undefined
      ? rule.cacheReadUsdPerMillion / 1_000_000
      : base.cacheReadCostPerToken,
    cacheWriteCostPerToken: rule.cacheCreateUsdPerMillion !== undefined
      ? rule.cacheCreateUsdPerMillion / 1_000_000
      : base.cacheWriteCostPerToken,
  };
}
