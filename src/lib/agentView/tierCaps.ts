import type { SubscriptionTier } from "@/lib/types";

export const TIER_LABELS: Record<SubscriptionTier, string> = {
  pro: "Claude Pro ($20/mo)",
  max5x: "Claude Max 5× ($100/mo)",
  max20x: "Claude Max 20× ($200/mo)",
  api: "API (pay-per-use)",
};

const TIER_MONTHLY_USD: Record<Exclude<SubscriptionTier, "api">, number> = {
  pro: 20,
  max5x: 100,
  max20x: 200,
};

/**
 * Returns the effective daily cap in USD, or null if none is configured.
 * Explicit `dailyUsd` takes precedence over the tier's monthly-derived cap.
 */
export function getEffectiveDailyCapUsd(
  tier: SubscriptionTier | undefined,
  dailyUsd: number | undefined,
): number | null {
  if (dailyUsd != null && dailyUsd > 0) return dailyUsd;
  if (!tier || tier === "api") return null;
  return TIER_MONTHLY_USD[tier] / 30;
}
