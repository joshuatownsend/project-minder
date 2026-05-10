export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function msLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// Returns an ISO-8601 string for N days ago (default 7), bucketed to the
// current hour so consecutive calls within the same hour return the EXACT
// same string. Without bucketing, every render gets a fresh millisecond and
// any consumer that uses the result as a fetch URL or useEffect dep keeps
// re-firing — observed as the Stats page rapidly re-fetching its telemetry
// cards in a tight loop. For "data from 7 days ago" purposes, hour-level
// precision is far more than enough.
export function defaultSince(days = 7): string {
  const HOUR_MS = 60 * 60 * 1000;
  const nowBucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(nowBucket - days * 24 * HOUR_MS).toISOString();
}

// ── Cost formatting ──────────────────────────────────────────────────────────

import { ZERO_DECIMAL_CURRENCIES, CURRENCY_SYMBOL } from "@/lib/currencies";

export function formatCost(amountUsd: number, currency = "USD", fxRate = 1): string {
  const amount = amountUsd * fxRate;
  const sym = CURRENCY_SYMBOL[currency] ?? currency;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return `${sym}${Math.round(amount)}`;
  }
  if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
  if (amount >= 0.01) return `${sym}${amount.toFixed(3)}`;
  if (amount > 0) return `${sym}${amount.toFixed(4)}`;
  return `${sym}0`;
}

/**
 * Compact variant — narrower precision thresholds for tight UI contexts.
 */
export function formatCostCompact(amountUsd: number, currency = "USD", fxRate = 1): string {
  const amount = amountUsd * fxRate;
  const sym = CURRENCY_SYMBOL[currency] ?? currency;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    const rounded = Math.round(amount);
    return amount > 0 && rounded === 0 ? `${sym}<1` : `${sym}${rounded}`;
  }
  if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
  if (amount >= 0.001) return `${sym}${amount.toFixed(3)}`;
  return `${sym}${amount.toFixed(4)}`;
}
