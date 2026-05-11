export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Like formatTokens, but treats null/0 as missing and renders "—". The
 *  efficiency panel uses this where 0 tokens is a legitimate "no data"
 *  signal rather than a real measurement. */
export function formatTokensOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return "—";
  return formatTokens(n);
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

// ── Percentages and durations ───────────────────────────────────────────────

/** Render a fraction in [0, 1] as a rounded percentage. Treats null/undefined
 *  as missing and renders "—" so callers don't have to guard. */
export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

/** Render a duration in seconds. Uses `s`/`m`/`h Xm` rungs — matches the
 *  shape DiagnosisPanel and sessionDiagnosis used inline before
 *  consolidation. */
export function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Render a duration in milliseconds. Treats falsy ms (0/undefined) as
 *  missing and returns "—". Uses `s`/`m Xs`/`h Xm` rungs — minute scale
 *  shows the sub-minute remainder so the per-session detail view can
 *  distinguish "5m 0s" from "5m 59s". Note: SessionTimeline keeps its
 *  sub-second-precision variant locally because it cares about
 *  distinguishing 80ms from 800ms. */
export function formatDurationMs(ms?: number): string {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Compact ms duration — drops the trailing seconds at minute scale.
 *  Used by list-rollup views (sessions browser, per-project sessions)
 *  where the extra precision is noise across many rows. */
export function formatDurationMsCompact(ms?: number): string {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
