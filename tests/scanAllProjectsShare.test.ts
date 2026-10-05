import { describe, it, expect, vi, beforeEach } from "vitest";

// A full scan is ~60 s of CPU on a large tree, and callers routinely arrive while
// one is running (the detached boot warm-up, ~20 routes that fall back to a scan on
// a cold cache). These pin that they share it, and that a rescan requested after an
// invalidation never joins a scan that began before it.

const gates: Array<() => void> = [];
const readConfig = vi.fn(
  () =>
    new Promise((resolve) => {
      gates.push(() =>
        resolve({
          statuses: {},
          hidden: [],
          portOverrides: {},
          devRoot: "C:\\dev",
          pinnedSlugs: [],
          featureFlags: { demoMode: true }, // returns demo fixtures right after the config read: no fs walk
        })
      );
    })
);

vi.mock("@/lib/config", () => ({
  readConfig: () => readConfig(),
  getDevRoots: () => [],
}));

import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, invalidateCache, setCachedScan } from "@/lib/cache";
import type { ScanResult } from "@/lib/types";

const g = globalThis as unknown as { __scanInFlight?: unknown; __scanGeneration?: number; __scanCache?: unknown };

/** Let the pending `readConfig` of the n-th started scan resolve. */
async function releaseScan(n: number) {
  await vi.waitFor(() => expect(gates.length).toBeGreaterThan(n));
  gates[n]();
}

describe("scanAllProjects shares one in-flight scan", () => {
  beforeEach(() => {
    readConfig.mockClear();
    gates.length = 0;
    delete g.__scanInFlight;
    delete g.__scanCache;
    g.__scanGeneration = 0;
  });

  it("runs once for concurrent callers and hands them the same result", async () => {
    const a = scanAllProjects();
    const b = scanAllProjects();
    expect(b).toBe(a);
    await releaseScan(0);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(readConfig).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh scan once the previous one has finished", async () => {
    const first = scanAllProjects();
    await releaseScan(0);
    await first;
    const second = scanAllProjects();
    await releaseScan(1);
    await second;
    expect(readConfig).toHaveBeenCalledTimes(2);
  });

  it("does not join a scan that began before an invalidation", async () => {
    const stale = scanAllProjects();
    invalidateCache(); // the real one: bumps the generation the scan guard keys on
    const fresh = scanAllProjects();
    expect(fresh).not.toBe(stale);
    // ...and later callers join the FRESH one, not the stale one.
    expect(scanAllProjects()).toBe(fresh);

    await releaseScan(0);
    await stale; // the stale scan finishing must not clear the fresh scan's marker
    expect(scanAllProjects()).toBe(fresh);

    await releaseScan(1);
    await fresh;
    expect(readConfig).toHaveBeenCalledTimes(2);
  });

  // The generation guard only picks which promise a caller gets. The result of a scan
  // that began before an invalidation must also never be PUBLISHED, or finishing last it
  // would put pre-invalidation data back in the cache for the whole TTL (Codex + Copilot, #609).
  it("refuses to cache a scan that was overtaken by an invalidation, even when it finishes last", async () => {
    const stale = scanAllProjects();
    invalidateCache();
    const fresh = scanAllProjects();

    await releaseScan(1); // the post-invalidation scan finishes FIRST...
    setCachedScan(await fresh);
    expect(getCachedScan()).toBe(await fresh);

    await releaseScan(0); // ...then the older one finishes and tries to publish
    const staleResult = await stale;
    setCachedScan(staleResult);
    expect(getCachedScan()).toBe(await fresh);
    expect(getCachedScan()).not.toBe(staleResult);
  });

  it("leaves the cache empty rather than caching a stale scan when nothing newer has published", async () => {
    const stale = scanAllProjects();
    invalidateCache();
    await releaseScan(0);
    setCachedScan(await stale);
    expect(getCachedScan()).toBeNull();
  });

  it("still caches a scan nothing invalidated, and a result that did not come from a scan", async () => {
    const scan = scanAllProjects();
    await releaseScan(0);
    const result = await scan;
    setCachedScan(result);
    expect(getCachedScan()).toBe(result);

    invalidateCache();
    const handBuilt = { projects: [] } as unknown as ScanResult;
    setCachedScan(handBuilt);
    expect(getCachedScan()).toBe(handBuilt);
  });

  it("does not stay stuck on a scan that failed", async () => {
    readConfig.mockImplementationOnce(() => Promise.reject(new Error("config boom")));
    await expect(scanAllProjects()).rejects.toThrow("config boom");
    const next = scanAllProjects();
    await releaseScan(0);
    await expect(next).resolves.toBeDefined();
  });
});
