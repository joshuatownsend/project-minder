/**
 * PR #455 round 2 — the routes' own use of the race-safe cache path.
 *
 * Separate file because `demoCacheBypass.test.ts` mocks the claude-config
 * route module wholesale (for the config-PATCH tests), which would hide the
 * very handler these drive.
 *
 * These exist because testing `TtlCache.getOrLoad` in isolation proved
 * insufficient: a mutation reverting /api/plans to a hand-rolled
 * `get`/`await`/`set` passed the entire suite. A unit test of the mechanism
 * says nothing about whether the caller reaches for it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

describe("the routes actually use the race-safe path", () => {
  /**
   * Testing `TtlCache.getOrLoad` in isolation is not enough: a mutation that
   * reverted /api/plans to a hand-rolled `get`/`await`/`set` passed the whole
   * suite. The unit covering the mechanism says nothing about whether the
   * route reaches for it — so these drive the handler and reproduce the race
   * through it.
   */
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("/api/plans does not cache a load that finished after a dispose", async () => {
    let release!: (v: unknown[]) => void;
    vi.doMock("@/lib/scanner/claudePlans", () => ({
      scanClaudePlans: () => new Promise((r) => (release = r)),
    }));

    const { getOrCreateRouteCache } = await import("@/lib/routeCache");
    const cache = getOrCreateRouteCache<unknown[]>("plans", { ttlMs: 120_000, maxEntries: 1 });
    cache.clear();

    const { GET } = await import("@/app/api/plans/route");
    const res = GET(new NextRequest("http://localhost:4100/api/plans"));

    cache.dispose(); // Settings enables demo mode mid-request
    release([{ title: "a real plan" }]);
    await res;

    expect(cache.get("all")).toBeUndefined();
  });

  it("/api/claude-config does not cache a load that finished after a dispose", async () => {
    let release!: (v: unknown) => void;
    vi.doMock("@/lib/server/queries/config", () => ({
      loadClaudeConfigResponse: () => new Promise((r) => (release = r)),
    }));

    const { getOrCreateRouteCache } = await import("@/lib/routeCache");
    const cache = getOrCreateRouteCache<unknown>("claude-config", { ttlMs: 120_000 });
    cache.clear();

    const { GET } = await import("@/app/api/claude-config/route");
    const res = GET(new NextRequest("http://localhost:4100/api/claude-config"));

    cache.dispose();
    release({ hooks: ["a real hook command"] });
    await res;

    expect(cache.get("all|")).toBeUndefined();
  });
});
