import { describe, it, expect } from "vitest";
import type { QuotaWindow } from "@/lib/quota";
import {
  computeProjectedUtilization,
  computeCapTimeMs,
  computeBurnHeadline,
  formatCountdown,
  windowDurationSecs,
  scheduleActiveFraction,
} from "@/lib/quotaProjection";

// A fixed, arbitrary "now" so every case is deterministic (no wall-clock reads).
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

/**
 * Build a window that is `elapsedFrac` of the way through its rolling window,
 * at the given utilization. `reset` is derived so `nowMs = NOW_MS` lands exactly
 * at that elapsed fraction.
 */
function windowAt(key: "5h" | "7d", elapsedFrac: number, utilization: number): QuotaWindow {
  const total = windowDurationSecs(key);
  const secsLeft = total * (1 - elapsedFrac);
  const reset = Math.round(NOW_S + secsLeft);
  return { utilization, status: "allowed", reset, resetAt: new Date(reset * 1000).toISOString() };
}

describe("computeProjectedUtilization", () => {
  it("extrapolates the current rate linearly (25% at the halfway mark → ~50%)", () => {
    const w = windowAt("5h", 0.5, 0.25);
    expect(computeProjectedUtilization(w, "5h", "24x7", NOW_MS)).toBeCloseTo(0.5, 5);
  });

  it("clamps a runaway projection at 2 (200%)", () => {
    const w = windowAt("5h", 0.1, 0.9); // rate would project to 9.0
    expect(computeProjectedUtilization(w, "5h", "24x7", NOW_MS)).toBe(2);
  });

  it("scales the 7d projection by the schedule's active fraction", () => {
    const w = windowAt("7d", 0.5, 0.25); // raw projection 0.5
    const full = computeProjectedUtilization(w, "7d", "24x7", NOW_MS);
    const weekdays = computeProjectedUtilization(w, "7d", "weekdays", NOW_MS);
    expect(full).toBeCloseTo(0.5, 5);
    expect(weekdays).toBeCloseTo(0.5 * scheduleActiveFraction("weekdays"), 5);
    expect(weekdays!).toBeLessThan(full!);
  });

  it("does not scale the 5h window by schedule (always continuous)", () => {
    const w = windowAt("5h", 0.5, 0.25);
    expect(computeProjectedUtilization(w, "5h", "weekdays", NOW_MS)).toBeCloseTo(0.5, 5);
  });

  it("returns null when there's no usable reset (reset = 0)", () => {
    const w: QuotaWindow = { utilization: 0.5, status: "allowed", reset: 0, resetAt: "" };
    expect(computeProjectedUtilization(w, "5h", "24x7", NOW_MS)).toBeNull();
  });

  it("returns null once the reset moment has already passed (stale cache)", () => {
    // A client cache that outlived its reset: reset is 10 min in the past.
    const w: QuotaWindow = {
      utilization: 0.5,
      status: "allowed",
      reset: Math.round(NOW_S - 600),
      resetAt: "",
    };
    // Without the secsLeft<=0 guard this would divide by an elapsedFrac > 1 and
    // return a projection *below* the current 50% util — a contradictory value.
    expect(computeProjectedUtilization(w, "5h", "24x7", NOW_MS)).toBeNull();
    expect(computeCapTimeMs(w, "5h", NOW_MS)).toBeNull();
  });

  it("returns null for a bogus reset further out than the window length", () => {
    const total = windowDurationSecs("5h");
    const w: QuotaWindow = {
      utilization: 0.5,
      status: "allowed",
      reset: Math.round(NOW_S + total + 3600), // resets in > 5h — impossible for a 5h window
      resetAt: "",
    };
    expect(computeProjectedUtilization(w, "5h", "24x7", NOW_MS)).toBeNull();
  });
});

describe("computeCapTimeMs", () => {
  it("projects a cap time when the rate will hit 100% before reset", () => {
    // Halfway through a 5h window at 60% → 40% capacity left at a rate of
    // 60%/9000s → caps in another 6000s.
    const w = windowAt("5h", 0.5, 0.6);
    const cap = computeCapTimeMs(w, "5h", NOW_MS);
    expect(cap).not.toBeNull();
    expect(cap! - NOW_MS).toBeCloseTo(6000 * 1000, -3);
  });

  it("returns null when the window resets before it would cap", () => {
    // Halfway at 50%: caps in exactly one more half-window == the reset moment,
    // so it does not cap *before* reset.
    const w = windowAt("5h", 0.5, 0.5);
    expect(computeCapTimeMs(w, "5h", NOW_MS)).toBeNull();
  });

  it("returns nowMs when already at or past the cap", () => {
    const w = windowAt("5h", 0.5, 1);
    expect(computeCapTimeMs(w, "5h", NOW_MS)).toBe(NOW_MS);
  });

  it("returns null at zero utilization (no rate to extrapolate)", () => {
    const w = windowAt("5h", 0.5, 0);
    expect(computeCapTimeMs(w, "5h", NOW_MS)).toBeNull();
  });
});

describe("computeBurnHeadline", () => {
  it("reports the more-utilized window as the headline", () => {
    const windows = { "5h": windowAt("5h", 0.5, 0.8), "7d": windowAt("7d", 0.5, 0.3) };
    const h = computeBurnHeadline(windows, NOW_MS);
    expect(h.worstKey).toBe("5h");
    expect(h.worstUtil).toBeCloseTo(0.8, 5);
  });

  it("surfaces the soonest cap across both windows", () => {
    // 5h caps sooner (high, spiky); 7d well under.
    const windows = { "5h": windowAt("5h", 0.5, 0.7), "7d": windowAt("7d", 0.5, 0.2) };
    const h = computeBurnHeadline(windows, NOW_MS);
    expect(h.capKey).toBe("5h");
    expect(h.capAtMs).not.toBeNull();
  });

  it("reports no cap when neither window is on track to cap", () => {
    const windows = { "5h": windowAt("5h", 0.5, 0.2), "7d": windowAt("7d", 0.5, 0.1) };
    const h = computeBurnHeadline(windows, NOW_MS);
    expect(h.capAtMs).toBeNull();
    expect(h.capKey).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("shows minutes under an hour", () => {
    expect(formatCountdown(40 * 60)).toBe("40m");
  });
  it("shows hours and minutes under a day", () => {
    expect(formatCountdown(3 * 3600 + 40 * 60)).toBe("3h 40m");
  });
  it("shows days and hours past a day", () => {
    expect(formatCountdown(2 * 24 * 3600 + 3 * 3600)).toBe("2d 3h");
  });
  it("collapses to 'now' at or below zero", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5)).toBe("now");
  });
});
