import { describe, it, expect, beforeEach } from "vitest";
import { claimCooldown, resetCooldowns } from "@/lib/notifications/rules/cooldown";

beforeEach(() => resetCooldowns());

describe("claimCooldown", () => {
  it("allows the first claim and blocks a second inside the window", () => {
    expect(claimCooldown("r1", "app", 60, 1_000)).toBe(true);
    expect(claimCooldown("r1", "app", 60, 30_000)).toBe(false);
  });

  it("allows again once the window has elapsed", () => {
    expect(claimCooldown("r1", "app", 60, 1_000)).toBe(true);
    expect(claimCooldown("r1", "app", 60, 61_001)).toBe(true);
  });

  it("tracks each rule independently", () => {
    expect(claimCooldown("r1", "app", 60, 1_000)).toBe(true);
    expect(claimCooldown("r2", "app", 60, 1_000)).toBe(true);
  });

  it("tracks each project independently — one noisy repo must not mute another", () => {
    expect(claimCooldown("r1", "app", 60, 1_000)).toBe(true);
    expect(claimCooldown("r1", "other", 60, 1_000)).toBe(true);
    expect(claimCooldown("r1", "app", 60, 2_000)).toBe(false);
  });

  it("treats a zero or negative cooldown as no throttling", () => {
    expect(claimCooldown("r1", "app", 0, 1_000)).toBe(true);
    expect(claimCooldown("r1", "app", 0, 1_001)).toBe(true);
    expect(claimCooldown("r2", "app", -5, 1_000)).toBe(true);
    expect(claimCooldown("r2", "app", -5, 1_001)).toBe(true);
  });

  it("treats a non-finite cooldown as no throttling rather than blocking forever", () => {
    expect(claimCooldown("r1", "app", Number.NaN, 1_000)).toBe(true);
    expect(claimCooldown("r1", "app", Number.NaN, 1_001)).toBe(true);
  });

  it("clamps an absurd cooldown to the documented maximum", () => {
    const oneDay = 24 * 60 * 60 * 1_000;
    expect(claimCooldown("r1", "app", 10_000_000, 0)).toBe(true);
    expect(claimCooldown("r1", "app", 10_000_000, oneDay - 1)).toBe(false);
    expect(claimCooldown("r1", "app", 10_000_000, oneDay + 1)).toBe(true);
  });

  it("keeps throttling the hot key after an eviction sweep", () => {
    // Eviction drops the oldest half. A naive `clear()` would reset every
    // active cooldown at once, turning a memory bound into a notification
    // storm — so the most recently used key must survive.
    claimCooldown("hot", "app", 600, 1_000_000);
    for (let i = 0; i < 600; i++) {
      claimCooldown(`filler${i}`, "app", 600, 1_000 + i);
    }
    expect(claimCooldown("hot", "app", 600, 1_000_001)).toBe(false);
  });
});
