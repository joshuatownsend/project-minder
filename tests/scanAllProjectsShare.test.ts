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

const g = globalThis as unknown as { __scanInFlight?: unknown; __scanGeneration?: number };

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
    g.__scanGeneration = (g.__scanGeneration ?? 0) + 1; // what invalidateCache() does
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

  it("does not stay stuck on a scan that failed", async () => {
    readConfig.mockImplementationOnce(() => Promise.reject(new Error("config boom")));
    await expect(scanAllProjects()).rejects.toThrow("config boom");
    const next = scanAllProjects();
    await releaseScan(0);
    await expect(next).resolves.toBeDefined();
  });
});
