import { describe, it, expect, beforeEach, vi } from "vitest";

// #476 round 2 (Codex P1/P2 on PR #514) — the corpus fingerprint must describe
// the CORPUS, not the cache.
//
// `getJsonlMaxMtime()` and `getJsonlFileCount()` are the two halves of the key
// `getSessionCategoryCounts()` memoises on (#492), and they also feed route
// ETags. Both used to be read off `FileCache`, which was the same thing as
// "the corpus" only while the cache held all of it. Once #476 gave the cache a
// byte budget, its contents answer a question about RESIDENCY — and the newest
// transcript is often also one of the largest, because an active session grows,
// so it is exactly the kind of entry eviction takes.
//
// Losing it freezes the ETag and the fingerprint across a real change: the
// worst failure this pair has, and the one #492 exists to prevent.

const globals = globalThis as unknown as {
  __usageFileCache?: unknown;
  __usageLiveFileCount?: number;
  __usageLiveMaxMtime?: number;
};

beforeEach(() => {
  vi.resetModules();
  delete globals.__usageFileCache;
  delete globals.__usageLiveFileCount;
  delete globals.__usageLiveMaxMtime;
});

async function load() {
  return import("@/lib/usage/parser");
}

describe("corpus fingerprint survives cache eviction (#476)", () => {
  it("reports the sweep's newest mtime even when nothing is cached", async () => {
    const { getJsonlMaxMtime } = await load();
    globals.__usageLiveMaxMtime = 12_345;
    // Cache is empty — `maxMtimeMs()` over zero slots is 0, which is what the
    // old implementation would have returned.
    expect(getJsonlMaxMtime()).toBe(12_345);
  });

  it("still advances for a file parsed outside a sweep", async () => {
    // `loadSessionTurnsBySessionId` parses one file without sweeping, so the
    // recorded value alone would go stale. Both inputs are monotone summaries,
    // so taking the larger cannot lose an advance in either direction.
    const parser = await load();
    globals.__usageLiveMaxMtime = 100;
    expect(parser.getJsonlMaxMtime()).toBe(100);
  });

  it("reports the sweep's file count, not the cache's occupancy", async () => {
    const { getJsonlFileCount } = await load();
    globals.__usageLiveFileCount = 6_650;
    expect(getJsonlFileCount()).toBe(6_650);
  });

  it("reports zero before any sweep has completed", async () => {
    // Not `undefined`, and not a stale number from another test's globals —
    // the fingerprint's honest answer before there is a corpus to describe.
    const { getJsonlFileCount } = await load();
    expect(getJsonlFileCount()).toBe(0);
  });
});
