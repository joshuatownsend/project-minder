export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function msLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// Returns an ISO-8601 string for N days ago (default 7).
export function defaultSince(days = 7): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
    return rounded === 0 ? `<1${sym}` : `${sym}${rounded}`;
  }
  if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
  if (amount >= 0.001) return `${sym}${amount.toFixed(3)}`;
  return `${sym}${amount.toFixed(4)}`;
}
