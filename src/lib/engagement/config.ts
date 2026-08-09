import type { EngagementConfig } from "./types";

const MIN = 60_000;

/**
 * Default thresholds. **These were measured against this corpus, not chosen
 * for roundness** — a billing number defended with "10 minutes felt right"
 * does not survive a client asking why.
 *
 * Measurement (2026-08-09, `C--dev-sales-dashboards`, 120 sessions /
 * 14,334 turns / 2026-06-27..2026-08-05, 579 samples): the distribution of
 * *response latency* — agent falls silent, then the human types — decays
 * smoothly, but its **per-minute density** has one sharp cliff:
 *
 *     0–0.5 min   37.6 %/min     8–10 min    1.55 %/min
 *     0.5–1 min   21.0 %/min    10–15 min    1.08 %/min
 *     1–2 min     14.7 %/min    15–20 min    0.32 %/min   <- 3.4x cliff
 *     2–3 min     11.4 %/min    20–30 min    0.24 %/min
 *     3–5 min      6.1 %/min    30–45 min    0.23 %/min
 *     5–8 min      2.6 %/min    60+  min     0.02 %/min
 *
 * Below 15 minutes the density is a decaying *reply* curve; past it the curve
 * flattens into a long "walked away" tail that no longer depends on elapsed
 * time. 15 minutes is where one behaviour stops and the other starts, so
 * that is the default — not the 10 the user first proposed, which sits
 * mid-slope and clips ~9 % of genuine replies.
 *
 * `runCapMs` = 30 min is the p95 of agent-busy spans between human prompts
 * (p50 2.7, p75 8.4, p90 18.1, p95 29.8, max 512). Past p95 a run is an
 * outlier that a person plausibly walked away from even if they replied
 * promptly on return.
 *
 * `tailCreditMs` = 3 min covers reading the final response and verifying the
 * result, which produces no transcript event. It is the smallest of the three
 * knobs: ±1 min moves the sales-dashboards total by ~2 h across 5 weeks.
 *
 * Sensitivity, same corpus, so the cost of a different choice is visible:
 *
 *     responseThreshold   3 min -> 51.7 h      15 min -> 80.1 h
 *                         5 min -> 58.8 h      20 min -> 83.9 h
 *                        10 min -> 71.6 h      60 min -> 112.9 h
 */
export const DEFAULT_ENGAGEMENT_CONFIG: EngagementConfig = {
  responseThresholdMs: 15 * MIN,
  runCapMs: 30 * MIN,
  tailCreditMs: 3 * MIN,
};

/** Bounds for user-supplied overrides, so a query param can't produce a
 *  nonsense invoice (negative credit, or a 24-hour "idle" threshold that
 *  bills an entire unattended weekend). */
const LIMITS = {
  responseThresholdMs: { min: 1 * MIN, max: 120 * MIN },
  runCapMs: { min: 1 * MIN, max: 240 * MIN },
  tailCreditMs: { min: 0, max: 30 * MIN },
} as const;

function clampMs(value: unknown, key: keyof typeof LIMITS, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const { min, max } = LIMITS[key];
  return Math.min(max, Math.max(min, n));
}

/**
 * Build a validated config from partial (possibly hostile) input — query
 * params or `.minder.json`. Unset or unparseable fields fall back to the
 * measured defaults rather than to zero, which would silently produce a
 * report of nothing but tail credit.
 */
export function resolveEngagementConfig(
  overrides?: Partial<Record<keyof EngagementConfig, unknown>> | null,
): EngagementConfig {
  const d = DEFAULT_ENGAGEMENT_CONFIG;
  if (!overrides) return { ...d };
  return {
    responseThresholdMs: clampMs(overrides.responseThresholdMs, "responseThresholdMs", d.responseThresholdMs),
    runCapMs: clampMs(overrides.runCapMs, "runCapMs", d.runCapMs),
    tailCreditMs: clampMs(overrides.tailCreditMs, "tailCreditMs", d.tailCreditMs),
  };
}
