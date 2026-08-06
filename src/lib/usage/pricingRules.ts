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
  // Spread `base` first so optional rates a rule cannot express — the tiered
  // >200k surcharges and the 1-hour cache-write rate — survive the overlay.
  // Listing the four fields explicitly (as this did before) silently dropped
  // them, so any user with a single pricing rule lost long-context pricing
  // entirely.
  const overlaid: ModelPricing = {
    ...base,
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
  // A rule that overrides the cache-write rate is expressing "this is what a
  // cache write costs me". It has no separate 1-hour field, so carrying the
  // stock 2x rate forward would let the override apply to 5-minute writes only
  // and leave 1-hour writes at the provider's price. Scale the 1-hour rate by
  // the same ratio instead, preserving the 5m:1h relationship.
  if (rule.cacheCreateUsdPerMillion !== undefined && base.cacheWrite1hCostPerToken !== undefined) {
    const ratio = base.cacheWriteCostPerToken > 0
      ? base.cacheWrite1hCostPerToken / base.cacheWriteCostPerToken
      : 1;
    overlaid.cacheWrite1hCostPerToken = overlaid.cacheWriteCostPerToken * ratio;
  }
  // Same argument for the >200k tier. A rule overriding the input price is
  // saying "this is what input costs me"; carrying the provider's above-200k
  // rate through unscaled would apply the override to sub-200k prompts only and
  // leave long prompts at list price — and, once a rule undercuts list, produce
  // the incoherent card where the "discounted" long rate exceeds the base one.
  // Scale by the same ratio so the tier's shape survives the override.
  //
  // Reachable only since the fallback table started publishing tier rates for
  // the Sonnet 4.5 lineage (#376): before that, no offline model had these
  // fields, so the preservation added in #375 had nothing to preserve.
  if (rule.inputUsdPerMillion !== undefined && base.inputCostPerTokenAbove200k !== undefined) {
    const ratio = base.inputCostPerToken > 0
      ? base.inputCostPerTokenAbove200k / base.inputCostPerToken
      : 1;
    overlaid.inputCostPerTokenAbove200k = overlaid.inputCostPerToken * ratio;
  }
  if (rule.outputUsdPerMillion !== undefined && base.outputCostPerTokenAbove200k !== undefined) {
    const ratio = base.outputCostPerToken > 0
      ? base.outputCostPerTokenAbove200k / base.outputCostPerToken
      : 1;
    overlaid.outputCostPerTokenAbove200k = overlaid.outputCostPerToken * ratio;
  }
  return overlaid;
}
