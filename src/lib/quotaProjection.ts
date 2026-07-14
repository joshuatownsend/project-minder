import type { QuotaWindow } from "./quota";
import type { ScheduleMode } from "./types";
import { SCHEDULE_MODES } from "./types";

/**
 * Pure burn-rate projection helpers shared by the /settings burndown chart and
 * the top-bar burn HUD. Every function takes `nowMs` explicitly so it's
 * deterministic and unit-testable — no wall-clock reads live here.
 *
 * The math extrapolates the *authoritative* rate-limit utilization Anthropic
 * reports in the `anthropic-ratelimit-unified-*` headers (see `loadQuota`), not
 * Minder's indexed usage turns: the header already reflects real consumption
 * across every Claude client on the account, so re-deriving from local turns
 * would produce a second number that can disagree with the limit shown beside
 * it.
 */

export type WindowKey = "5h" | "7d";

/** Total length of a rolling window in seconds. */
export function windowDurationSecs(key: WindowKey): number {
  return key === "5h" ? 5 * 3600 : 7 * 24 * 3600;
}

/** Fraction of the 7-day window a developer is realistically active, per their
 *  configured schedule. The 5h window is always treated as continuous. */
export function scheduleActiveFraction(mode: ScheduleMode): number {
  switch (mode) {
    case "weekdays":   return 5 / 7;
    case "vibe-coder": return 0.7;
    case "custom":
    case "24x7":       return 1;
  }
}

export function scheduleLabel(mode: ScheduleMode): string {
  return SCHEDULE_MODES.find((m) => m.value === mode)?.label ?? mode;
}

/** Colour token for a utilization level (green < 70%, amber 70–90%, red ≥ 90%).
 *  Kept here so the chart and HUD stay in visual lockstep. */
export function utilColor(utilization: number): string {
  if (utilization >= 0.9) return "var(--status-error-text, #f87171)";
  if (utilization >= 0.7) return "var(--warning, #fb923c)";
  return "var(--status-active-text, #4ade80)";
}

/**
 * Seconds elapsed into the current window, or null when the reset header gives
 * us nothing usable: no reset at all, a reset already in the past (a client
 * cache that outlived the reset moment — the header is stale until the next
 * refetch), a reset further out than the window length (bogus / just-reset), or
 * a window that hasn't advanced yet (no rate to project from).
 */
function elapsedSecs(window: QuotaWindow, key: WindowKey, nowMs: number): number | null {
  const now = nowMs / 1000;
  const total = windowDurationSecs(key);
  const secsLeft = window.reset - now;
  // reset in the past → negative secsLeft; without this the projection would
  // show a nonsensical "~N% projected" (< current util) beside "resets in now".
  if (window.reset <= 0 || secsLeft <= 0 || secsLeft > total) return null;
  const elapsed = total - secsLeft;
  return elapsed > 0 ? elapsed : null;
}

/**
 * Projected end-of-window utilization (0–2, clamped) assuming the current
 * average rate holds to the reset. For the 7d window this is scaled down by the
 * schedule's active fraction (you won't burn 24/7); the 5h window is continuous.
 * Returns null when there's no usable rate yet.
 */
export function computeProjectedUtilization(
  window: QuotaWindow,
  key: WindowKey,
  scheduleMode: ScheduleMode,
  nowMs: number,
): number | null {
  const elapsed = elapsedSecs(window, key, nowMs);
  if (elapsed === null) return null;
  const total = windowDurationSecs(key);
  const elapsedFrac = elapsed / total;
  const activeFrac = key === "7d" ? scheduleActiveFraction(scheduleMode) : 1;
  return Math.min((window.utilization / elapsedFrac) * activeFrac, 2);
}

/**
 * Wall-clock timestamp (ms) at which utilization is projected to reach 100% at
 * this window's current average burn rate, or null when it won't cap before the
 * window resets (or there's no rate yet). Uses the *raw* linear rate — no
 * schedule scaling — so it answers the literal question "at the pace so far,
 * when do I hit the wall?". Already-capped windows return `nowMs`.
 */
export function computeCapTimeMs(window: QuotaWindow, key: WindowKey, nowMs: number): number | null {
  const elapsed = elapsedSecs(window, key, nowMs);
  if (elapsed === null || window.utilization <= 0) return null;
  if (window.utilization >= 1) return nowMs; // already at the cap
  const secsToCap = (elapsed * (1 - window.utilization)) / window.utilization;
  const secsLeft = window.reset - nowMs / 1000;
  if (secsToCap >= secsLeft) return null; // window resets before we'd cap
  return nowMs + secsToCap * 1000;
}

export interface BurnHeadline {
  /** Window driving the chip's utilization figure (the more-utilized of 5h/7d). */
  worstKey: WindowKey;
  /** Current utilization of that window, 0–1. */
  worstUtil: number;
  /** Soonest projected cap across 5h and 7d (ms), or null if neither will cap. */
  capAtMs: number | null;
  /** Which window that soonest cap belongs to. */
  capKey: WindowKey | null;
}

/**
 * Collapse both rolling windows into the single headline the HUD chip shows:
 * the more-utilized window's percentage, plus the soonest moment either window
 * is projected to hit 100%.
 */
export function computeBurnHeadline(
  windows: { "5h": QuotaWindow; "7d": QuotaWindow },
  nowMs: number,
): BurnHeadline {
  const w5 = windows["5h"];
  const w7 = windows["7d"];
  const worstKey: WindowKey = w5.utilization >= w7.utilization ? "5h" : "7d";
  const worstUtil = Math.max(w5.utilization, w7.utilization);

  const cap5 = computeCapTimeMs(w5, "5h", nowMs);
  const cap7 = computeCapTimeMs(w7, "7d", nowMs);
  let capAtMs: number | null = null;
  let capKey: WindowKey | null = null;
  if (cap5 !== null && (cap7 === null || cap5 <= cap7)) {
    capAtMs = cap5;
    capKey = "5h";
  } else if (cap7 !== null) {
    capAtMs = cap7;
    capKey = "7d";
  }

  return { worstKey, worstUtil, capAtMs, capKey };
}

/** Human "2d 3h" / "3h 40m" / "40m" countdown from a seconds-remaining value. */
export function formatCountdown(secsLeft: number): string {
  if (secsLeft <= 0) return "now";
  const h = Math.floor(secsLeft / 3600);
  const m = Math.floor((secsLeft % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
