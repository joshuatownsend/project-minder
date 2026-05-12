import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock readConfig + mutateConfig so we don't touch a real .minder.json.
const memCfg: { memoryTriage?: { suppressUntil?: Record<string, string> } } = {};

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(async () => memCfg),
  mutateConfig: vi.fn(async (fn: (cfg: typeof memCfg) => unknown) => {
    await fn(memCfg);
    return memCfg;
  }),
}));

import { setSuppress, getSuppressMap, clearSuppress } from "@/lib/memory/triageStore";

beforeEach(() => {
  for (const k of Object.keys(memCfg)) delete (memCfg as Record<string, unknown>)[k];
});

describe("setSuppress", () => {
  it("writes an ISO timestamp `days` ahead of `now`", async () => {
    const now = Date.parse("2026-05-12T00:00:00Z");
    const until = await setSuppress("/m/a.md", 30, now);
    expect(until).toBe(new Date(now + 30 * 24 * 60 * 60_000).toISOString());
    expect(memCfg.memoryTriage?.suppressUntil?.["/m/a.md"]).toBe(until);
  });

  it("clamps days < 1 up to 1", async () => {
    const now = Date.parse("2026-05-12T00:00:00Z");
    const until = await setSuppress("/m/a.md", 0, now);
    expect(until).toBe(new Date(now + 1 * 24 * 60 * 60_000).toISOString());
  });

  it("falls back to the default when days is NaN (defense-in-depth)", async () => {
    // Regression: a non-finite days value flowing through Math.floor → Math.max
    // would persist "Invalid Date" into .minder.json and corrupt every
    // subsequent suppress-map read. The store now coerces back to the default.
    const now = Date.parse("2026-05-12T00:00:00Z");
    const until = await setSuppress("/m/a.md", NaN, now);
    expect(until).toBe(new Date(now + 30 * 24 * 60 * 60_000).toISOString());
  });

  it("falls back to the default when days is Infinity", async () => {
    const now = Date.parse("2026-05-12T00:00:00Z");
    const until = await setSuppress("/m/a.md", Infinity, now);
    expect(until).toBe(new Date(now + 30 * 24 * 60 * 60_000).toISOString());
  });

  it("throws on empty absPath", async () => {
    await expect(setSuppress("", 7)).rejects.toThrow("absPath is required");
  });
});

describe("getSuppressMap / clearSuppress", () => {
  it("returns a defensive copy that doesn't bleed into the cached config", async () => {
    await setSuppress("/m/a.md", 30);
    const map = await getSuppressMap();
    map["/m/poison.md"] = "2099-01-01T00:00:00Z";
    const again = await getSuppressMap();
    expect(again["/m/poison.md"]).toBeUndefined();
  });

  it("clears a single entry", async () => {
    await setSuppress("/m/a.md", 30);
    await setSuppress("/m/b.md", 30);
    await clearSuppress("/m/a.md");
    const map = await getSuppressMap();
    expect(map["/m/a.md"]).toBeUndefined();
    expect(map["/m/b.md"]).toBeDefined();
  });

  it("is a no-op when the absPath wasn't suppressed", async () => {
    await expect(clearSuppress("/m/missing.md")).resolves.toBeUndefined();
  });
});
