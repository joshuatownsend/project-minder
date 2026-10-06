import { describe, it, expect, vi, beforeEach } from "vitest";

// A full scan is ~60 s of CPU on a large tree, and callers routinely arrive while one is
// running (the detached boot warm-up, ~20 routes that fall back to a scan on a cold cache).
// These pin two things (#609):
//   1. concurrent callers share ONE scan;
//   2. no caller is ever handed a scan that an invalidation overtook while it ran - the
//      consumers that act on a result (warm caches, resolve project paths, key per-slug
//      caches) are many, so the guarantee lives in scanAllProjects, not in each of them.

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

const g = globalThis as unknown as Record<string, unknown>;

/** Let the n-th started scan's config read resolve, i.e. let that scan finish. */
async function releaseScan(n: number) {
  await vi.waitFor(() => expect(gates.length).toBeGreaterThan(n));
  gates[n]();
}

describe("scanAllProjects", () => {
  beforeEach(() => {
    readConfig.mockClear();
    gates.length = 0;
    for (const k of ["__scanInFlight", "__scanCache", "__scanLatest", "__scanGeneration", "__scanResultGeneration"]) delete g[k];
    g.__scanGeneration = 0;
  });

  describe("shares one in-flight scan", () => {
    it("runs once for concurrent callers and hands them the same result", async () => {
      const a = scanAllProjects();
      const b = scanAllProjects();
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

    it("does not stay stuck on a scan that failed", async () => {
      readConfig.mockImplementationOnce(() => Promise.reject(new Error("config boom")));
      await expect(scanAllProjects()).rejects.toThrow("config boom");
      const next = scanAllProjects();
      await releaseScan(0);
      await expect(next).resolves.toBeDefined();
    });
  });

  describe("never hands a caller a scan an invalidation overtook", () => {
    it("a caller waiting on an overtaken scan joins the newer in-flight scan", async () => {
      const waiting = scanAllProjects(); // scan 0, held open
      invalidateCache(); // the world changed
      const fresh = scanAllProjects(); // scan 1: must be a NEW scan, not scan 0
      await vi.waitFor(() => expect(gates.length).toBe(2));

      await releaseScan(0); // the overtaken scan finishes first...
      await releaseScan(1); // ...its result must not reach `waiting`: it takes scan 1 (no third scan)
      const [rWaiting, rFresh] = await Promise.all([waiting, fresh]);
      expect(rWaiting).toBe(rFresh);
      expect(readConfig).toHaveBeenCalledTimes(2);
    });

    it("takes the newer scan that already finished instead of starting another", async () => {
      const waiting = scanAllProjects(); // scan 0, held open
      invalidateCache();
      const fresh = scanAllProjects(); // scan 1
      await releaseScan(1);
      const freshResult = await fresh; // nobody caches it: the scanner remembers its own latest

      await releaseScan(0); // the overtaken scan finishes LAST
      expect(await waiting).toBe(freshResult);
      expect(readConfig).toHaveBeenCalledTimes(2); // no redundant third scan
    });

    it("starts a new scan when nothing newer exists", async () => {
      const waiting = scanAllProjects(); // scan 0
      invalidateCache(); // overtaken, and nobody else has rescanned
      await releaseScan(0);
      await releaseScan(1); // the waiter started scan 1 itself
      const result = await waiting;
      expect(readConfig).toHaveBeenCalledTimes(2);
      expect(setCachedScan(result)).toBe(true); // it IS the current generation's scan
    });

    it("gives up after a bounded number of overtakes and returns a result the cache refuses", async () => {
      const waiting = scanAllProjects(); // scan 0
      invalidateCache();
      await releaseScan(0);
      await vi.waitFor(() => expect(gates.length).toBe(2)); // overtaken -> rescan (scan 1)
      invalidateCache();
      await releaseScan(1);
      await vi.waitFor(() => expect(gates.length).toBe(3)); // overtaken again -> rescan (scan 2)
      invalidateCache();
      await releaseScan(2); // overtaken a third time: the cap is reached, no scan 3

      const result = await waiting;
      expect(readConfig).toHaveBeenCalledTimes(3);
      expect(setCachedScan(result)).toBe(false); // began before the latest invalidation
      expect(getCachedScan()).toBeNull();
    });
  });

  describe("setCachedScan", () => {
    it("caches a result nothing invalidated, and one that did not come from a scan", async () => {
      const scan = scanAllProjects();
      await releaseScan(0);
      const result = await scan;
      expect(setCachedScan(result)).toBe(true);
      expect(getCachedScan()).toBe(result);

      invalidateCache();
      const handBuilt = { projects: [] } as unknown as ScanResult;
      expect(setCachedScan(handBuilt)).toBe(true);
      expect(getCachedScan()).toBe(handBuilt);
    });

    it("refuses a scan that began before an invalidation (the cache-level backstop)", async () => {
      const scan = scanAllProjects();
      await releaseScan(0);
      const result = await scan;
      invalidateCache(); // after the result was handed out, before it is published
      expect(setCachedScan(result)).toBe(false);
      expect(getCachedScan()).toBeNull();
    });
  });
});
