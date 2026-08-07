import { describe, it, expect, afterEach, vi } from "vitest";
import { periodToMs, periodToSince, resolveSinceParam, type Period } from "@/lib/telemetryPeriod";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Deliberately NOT on an hour boundary — 10:59:59.123, the case that exposed the bug. */
const MESSY_NOW = new Date("2026-08-07T10:59:59.123Z").getTime();

afterEach(() => {
  vi.useRealTimers();
});

describe("telemetryPeriod", () => {
  // The finding from the #402 review. The Telemetry section drives six cards
  // through two encodings: four send `periodToSince(...)`, two send the period
  // name for the route to resolve with `periodToMs(...)`. If those disagree,
  // one toggle silently covers two different windows.
  it("resolves the same instant whether the caller asks in ms or ISO", () => {
    vi.useFakeTimers({ now: MESSY_NOW });
    for (const period of ["today", "7d", "30d", "all"] as Period[]) {
      expect(Date.parse(periodToSince(period))).toBe(periodToMs(period));
    }
  });

  it("buckets the rolling windows to the hour regardless of who supplies the clock", () => {
    // Passing a raw, unbucketed timestamp must not bypass the invariant —
    // otherwise a caller reaching for the `now` param reintroduces the drift.
    for (const period of ["7d", "30d"] as Period[]) {
      expect(periodToMs(period, MESSY_NOW) % HOUR_MS).toBe(0);
    }
  });

  it("anchors the rolling windows the expected distance back", () => {
    const bucket = Math.floor(MESSY_NOW / HOUR_MS) * HOUR_MS;
    expect(periodToMs("7d", MESSY_NOW)).toBe(bucket - 7 * DAY_MS);
    expect(periodToMs("30d", MESSY_NOW)).toBe(bucket - 30 * DAY_MS);
  });

  it("is stable across a whole hour, so a re-render cannot re-fire the fetch", () => {
    vi.useFakeTimers({ now: MESSY_NOW });
    const first = periodToSince("7d");
    // Advance within the same hour bucket (10:59:59.123 -> 10:59:59.623).
    vi.setSystemTime(MESSY_NOW + 500);
    expect(periodToSince("7d")).toBe(first);
    // Crossing into the next hour is expected to move it.
    vi.setSystemTime(MESSY_NOW + HOUR_MS);
    expect(periodToSince("7d")).not.toBe(first);
  });

  it("maps 'all' to epoch 0 so the all-history checks fire", () => {
    // `getHookActivity` spells all-history as `since <= 0`; anything else here
    // silently turns all-time into a 1970 lower bound that still excludes
    // NULL-timestamped rows.
    expect(periodToMs("all", MESSY_NOW)).toBe(0);
    expect(periodToSince("all")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("maps 'today' to local midnight, not a rolling 24h", () => {
    const midnight = new Date(MESSY_NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(periodToMs("today", MESSY_NOW)).toBe(midnight.getTime());
  });
});

describe("resolveSinceParam", () => {
  const q = (s: string) => new URLSearchParams(s);

  it("prefers an explicit since over period", () => {
    vi.useFakeTimers({ now: MESSY_NOW });
    const iso = "2026-01-02T03:00:00.000Z";
    // Both present: `since` wins, so the cutoff in the URL is the cutoff used.
    expect(resolveSinceParam(q(`since=${encodeURIComponent(iso)}&period=30d`)).since)
      .toBe(Date.parse(iso));
  });

  it("falls back to period, and to 7d when neither is given", () => {
    vi.useFakeTimers({ now: MESSY_NOW });
    // The compatibility path for hand-written URLs — must still agree with the
    // client's own resolution of the same period.
    expect(resolveSinceParam(q("period=30d")).since).toBe(periodToMs("30d"));
    expect(resolveSinceParam(q("")).since).toBe(periodToMs("7d"));
  });

  it("rejects an unparseable since and an unknown period", () => {
    expect(resolveSinceParam(q("since=not-a-date")).error).toBeDefined();
    expect(resolveSinceParam(q("period=lastTuesday")).error).toBeDefined();
    // A rejected input must not also carry a usable cutoff — a caller that
    // ignored the error would otherwise silently query some default window.
    expect(resolveSinceParam(q("period=lastTuesday")).since).toBeUndefined();
  });
});
