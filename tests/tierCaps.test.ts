import { describe, it, expect } from "vitest";
import { getEffectiveDailyCapUsd } from "@/lib/agentView/tierCaps";

describe("getEffectiveDailyCapUsd", () => {
  it("returns null when neither tier nor dailyUsd is set", () => {
    expect(getEffectiveDailyCapUsd(undefined, undefined)).toBeNull();
  });

  it("returns null for api tier with no dailyUsd", () => {
    expect(getEffectiveDailyCapUsd("api", undefined)).toBeNull();
  });

  it("returns dailyUsd when explicitly set, regardless of tier", () => {
    expect(getEffectiveDailyCapUsd("pro", 5)).toBe(5);
    expect(getEffectiveDailyCapUsd("max5x", 10)).toBe(10);
    expect(getEffectiveDailyCapUsd(undefined, 3)).toBe(3);
  });

  it("returns tier-derived daily cap when dailyUsd is absent", () => {
    const proCap = getEffectiveDailyCapUsd("pro", undefined);
    expect(proCap).toBeCloseTo(20 / 30, 5);

    const max5xCap = getEffectiveDailyCapUsd("max5x", undefined);
    expect(max5xCap).toBeCloseTo(100 / 30, 5);

    const max20xCap = getEffectiveDailyCapUsd("max20x", undefined);
    expect(max20xCap).toBeCloseTo(200 / 30, 5);
  });

  it("ignores dailyUsd of zero — treats as unset, falls back to tier", () => {
    const cap = getEffectiveDailyCapUsd("pro", 0);
    // dailyUsd=0 fails the >0 guard so we fall back to tier
    expect(cap).toBeCloseTo(20 / 30, 5);
  });

  it("returns dailyUsd for api tier when dailyUsd is provided", () => {
    expect(getEffectiveDailyCapUsd("api", 7.5)).toBe(7.5);
  });
});
