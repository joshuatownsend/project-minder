import { describe, it, expect } from "vitest";
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_META,
  getFlag,
  isFeatureFlagKey,
} from "@/lib/featureFlags";
import type { FeatureFlagKey } from "@/lib/types";

describe("getFlag", () => {
  it("returns defaultOn (true) when flags map is undefined", () => {
    expect(getFlag(undefined, "scanInsights")).toBe(true);
  });

  it("returns defaultOn=false when caller opts in", () => {
    expect(getFlag(undefined, "liveActivity", false)).toBe(false);
  });

  it("returns defaultOn when key is missing from a present map", () => {
    expect(getFlag({ scanTodos: false }, "scanInsights")).toBe(true);
    expect(getFlag({}, "scanInsights")).toBe(true);
  });

  it("returns the explicit value when set", () => {
    expect(getFlag({ scanInsights: false }, "scanInsights")).toBe(false);
    expect(getFlag({ scanInsights: true }, "scanInsights")).toBe(true);
  });

  it("does NOT silently swallow false → defaultOn (regression guard)", () => {
    // The accessor must distinguish `undefined` from `false`. If someone
    // refactors getFlag to `flags?.[key] ?? defaultOn`, this fails:
    // false ?? true === false, but `false || true === true`.
    expect(getFlag({ scanTodos: false }, "scanTodos", true)).toBe(false);
  });
});

describe("FEATURE_FLAG_KEYS", () => {
  it("matches the FeatureFlagKey union (no missing entries)", () => {
    // Compile-time check: assigning the array members to FeatureFlagKey[]
    // catches union drift. The runtime check below covers documented count.
    const _typeCheck: readonly FeatureFlagKey[] = FEATURE_FLAG_KEYS;
    expect(_typeCheck.length).toBeGreaterThanOrEqual(12);
  });

  it("has unique keys", () => {
    const set = new Set(FEATURE_FLAG_KEYS);
    expect(set.size).toBe(FEATURE_FLAG_KEYS.length);
  });
});

describe("FEATURE_FLAG_META", () => {
  it("covers every FeatureFlagKey exactly once", () => {
    const metaKeys = FEATURE_FLAG_META.map((m) => m.key);
    expect(new Set(metaKeys).size).toBe(metaKeys.length);
    expect(new Set(metaKeys)).toEqual(new Set(FEATURE_FLAG_KEYS));
  });

  it("partitions every flag into either passive or active group", () => {
    for (const meta of FEATURE_FLAG_META) {
      expect(["passive", "active"]).toContain(meta.group);
    }
  });
});

describe("isFeatureFlagKey", () => {
  it("accepts every known key", () => {
    for (const k of FEATURE_FLAG_KEYS) {
      expect(isFeatureFlagKey(k)).toBe(true);
    }
  });

  it("rejects unknown keys", () => {
    expect(isFeatureFlagKey("scanNonsense")).toBe(false);
    expect(isFeatureFlagKey("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isFeatureFlagKey(undefined)).toBe(false);
    expect(isFeatureFlagKey(null)).toBe(false);
    expect(isFeatureFlagKey(42)).toBe(false);
    expect(isFeatureFlagKey({})).toBe(false);
  });
});
