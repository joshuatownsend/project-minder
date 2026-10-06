import { describe, it, expect, vi, beforeEach } from "vitest";

// The MCP tools' cache-first scan used to keep its own single-flight promise, blind to
// `invalidateCache()`. A forced `scan-projects` that invalidated mid-scan then joined the
// pre-invalidation scan, returned its data, and (with stale publication refused) left the
// cache empty. Dedup now lives in `scanAllProjects`, keyed to the cache generation (#609).
// Real scanner, cache and invalidation here: only the config read is gated, so a scan can
// be held open.

const gates: Array<() => void> = [];
let gated = false;
const cfg = {
  statuses: {},
  hidden: [],
  portOverrides: {},
  devRoot: "C:\\dev",
  pinnedSlugs: [],
  featureFlags: { demoMode: true }, // the scan returns demo fixtures right after the config read
};
const readConfig = vi.fn(() =>
  gated ? new Promise((resolve) => gates.push(() => resolve(cfg))) : Promise.resolve(cfg)
);

vi.mock("@/lib/config", () => ({ readConfig: () => readConfig(), getDevRoots: () => [] }));
vi.mock("@/lib/groups/withGroups", () => ({ withGroups: (r: unknown) => r }));

import { getCachedOrFreshScan } from "@/lib/mcp/scanHelper";
import { getCachedScan, invalidateCache } from "@/lib/cache";

const g = globalThis as unknown as Record<string, unknown>;

/** Start a scan whose config read is held open until `release(n)`. */
function startHeld<T>(start: () => Promise<T>): Promise<T> {
  gated = true;
  try {
    return start();
  } finally {
    gated = false;
  }
}
async function release(n: number) {
  await vi.waitFor(() => expect(gates.length).toBeGreaterThan(n));
  gates[n]();
}

describe("getCachedOrFreshScan (MCP) honours cache invalidation", () => {
  beforeEach(() => {
    readConfig.mockClear();
    gates.length = 0;
    for (const k of ["__scanCache", "__scanInFlight", "__scanLatest", "__scanGeneration", "__scanResultGeneration"]) delete g[k];
  });

  it("cold concurrent callers share one scan", async () => {
    const a = startHeld(() => getCachedOrFreshScan());
    const b = startHeld(() => getCachedOrFreshScan());
    await release(0);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(gates.length).toBe(1);
  });

  it("a forced rescan after invalidateCache() starts a new scan instead of joining the old one", async () => {
    const stale = startHeld(() => getCachedOrFreshScan()); // scan #0, held open
    invalidateCache(); // scan-projects { force: true }
    const fresh = startHeld(() => getCachedOrFreshScan()); // must be a NEW scan
    expect(gates.length).toBe(2);

    await release(1);
    const freshResult = await fresh;
    expect(getCachedScan()).toBe(freshResult);

    await release(0); // the older scan finishes last
    // Its data predates the invalidation: the caller is handed the newer scan instead, and the
    // cache still holds that one.
    expect(await stale).toBe(freshResult);
    expect(getCachedScan()).toBe(freshResult);
    expect(gates.length).toBe(2); // no third scan
  });
});
