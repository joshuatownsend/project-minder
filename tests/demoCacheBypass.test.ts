/**
 * PR #455 review round 1 — three defects that all shared one root shape:
 * something sitting ABOVE a demo guard, so the guard never got asked.
 *
 * The route caches are the interesting one. Seven loaders were guarded in this
 * PR, but two of the routes reading them cache the loader's answer under a
 * mode-agnostic key, so an entry warmed in real mode kept being served after
 * the Settings toggle enabled demo mode — past the guard, for the rest of the
 * TTL. Codex reported `/api/plans`; `/api/claude-config` had the identical
 * shape and was not reported, which is why the fix is central (dispose every
 * route cache on a config write) rather than per-key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { MinderConfig } from "@/lib/types";

const BASE_CONFIG: MinderConfig = {
  statuses: {},
  hidden: [],
  portOverrides: {},
  devRoot: "C:\\dev",
};

let stored: MinderConfig = { ...BASE_CONFIG };

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(async () => stored),
  mutateConfig: vi.fn(async (mutator: (c: MinderConfig) => void) => {
    const next = { ...stored };
    mutator(next);
    stored = next;
    return stored;
  }),
}));

vi.mock("@/lib/cache", () => ({ invalidateCache: vi.fn() }));
vi.mock("@/app/api/claude-config/route", () => ({
  invalidateClaudeConfigRouteCache: vi.fn(),
}));
vi.mock("@/lib/server/mutations/projectStatus", () => ({ setProjectStatus: vi.fn() }));
vi.mock("@/lib/usage/costCalculator", () => ({ setPricingRules: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ listAdapters: vi.fn(() => []) }));
vi.mock("@/lib/efficiencyGradeCache", () => ({
  efficiencyGradeCache: { invalidateGrades: vi.fn() },
}));
vi.mock("@/lib/server/queries/stats", () => ({ invalidateClaudeUsageCache: vi.fn() }));

import { PATCH } from "@/app/api/config/route";
import { getOrCreateRouteCache } from "@/lib/routeCache";

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4100/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a config write empties every route cache", () => {
  beforeEach(() => {
    stored = { ...BASE_CONFIG };
  });

  // Uses the REAL registry (routeCache is deliberately not mocked above) and
  // the REAL cache names the two routes register, so this breaks if either
  // route renames its cache or the dispose call is dropped from invalidateAll.
  it("drops a plans entry warmed before the demoMode flag flipped", async () => {
    const plans = getOrCreateRouteCache<string[]>("plans", { ttlMs: 120_000, maxEntries: 1 });
    plans.set("all", ["a real plan title"]);
    expect(plans.get("all")).toEqual(["a real plan title"]);

    const res = await PATCH(patchRequest({ featureFlags: { demoMode: true } }));

    expect(res.status).toBe(200);
    expect(plans.get("all")).toBeUndefined();
  });

  it("drops a claude-config entry too — the leak Codex did not report", async () => {
    const cfg = getOrCreateRouteCache<{ hooks: string[] }>("claude-config", { ttlMs: 120_000 });
    cfg.set("all|", { hooks: ["rm -rf /real/path"] });

    await PATCH(patchRequest({ featureFlags: { demoMode: true } }));

    expect(cfg.get("all|")).toBeUndefined();
  });

  // The bug is symmetrical: fixtures cached during a demo session must not
  // survive into real mode either, where they would read as real data.
  it("clears in the demo→real direction as well", async () => {
    const plans = getOrCreateRouteCache<string[]>("plans", { ttlMs: 120_000, maxEntries: 1 });
    plans.set("all", ["a demo fixture title"]);

    await PATCH(patchRequest({ featureFlags: { demoMode: false } }));

    expect(plans.get("all")).toBeUndefined();
  });

  // Any flag can change what a loader returns, so the dispose is not
  // conditional on demoMode — pinning that keeps a later "optimization" from
  // narrowing it back to one flag.
  it("is not special-cased to demoMode", async () => {
    const plans = getOrCreateRouteCache<string[]>("plans", { ttlMs: 120_000, maxEntries: 1 });
    plans.set("all", ["cached under some other flag state"]);

    await PATCH(patchRequest({ featureFlags: { scanBoard: false } }));

    expect(plans.get("all")).toBeUndefined();
  });
});

describe("demo mode never probes the MCP fixtures", () => {
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * `GET /api/mcp-health` short-circuits to fixtures and never reaches
   * `enqueueMcpHealth`, so the route guard says nothing about boot:
   * `bootMcpHealthCache()` calls the helper directly. That second caller is
   * the whole finding (Codex P2).
   *
   * This matters beyond tidiness. `demoUserConfig()` carries a Linear SSE URL
   * and `npx -y @modelcontextprotocol/server-github`, so an unguarded boot in
   * demo mode dials a third party — and with `mcpHealthStdioProbe` on, runs
   * npx. Asserting `enqueue` was never CALLED (rather than checking some
   * after-the-fact status) is the only assertion that pins "nothing left the
   * machine".
   */
  it("returns the fixture servers but never enqueues a probe", async () => {
    process.env.MINDER_DEMO = "1";
    const enqueue = vi.fn();
    vi.doMock("@/lib/mcpHealthCache", () => ({
      mcpHealthCache: { enqueue, setStdioHandshake: vi.fn() },
      serverIdentity: (s: { name: string }) => s.name,
    }));

    const { enqueueMcpHealth } = await import("@/lib/mcpHealthEnqueue");
    const servers = await enqueueMcpHealth({ mcpHealthStdioProbe: true });

    // The list still comes back — callers use it for `configuredIds`/logging.
    expect(servers.length).toBeGreaterThan(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Control: without the guard's mode, the same call DOES enqueue. Without
  // this, the assertion above would pass against a helper that never probes
  // in any mode at all.
  it("still enqueues in real mode", async () => {
    const enqueue = vi.fn();
    vi.doMock("@/lib/mcpHealthCache", () => ({
      mcpHealthCache: { enqueue, setStdioHandshake: vi.fn() },
      serverIdentity: (s: { name: string }) => s.name,
    }));
    vi.doMock("@/lib/userConfigCache", () => ({
      getUserConfig: async () => ({ mcpServers: { servers: [{ name: "real", scope: "user" }] } }),
    }));
    vi.doMock("@/lib/demo/demoMode", () => ({ demoMode: async () => false }));

    const { enqueueMcpHealth } = await import("@/lib/mcpHealthEnqueue");
    await enqueueMcpHealth({});

    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("demoStatsCache daily rows agree with the headline", () => {
  // Copilot, PR #455: an unconditional `Math.max(1, …)` put one session on
  // every one of the 14 days while `totalSessions` read 0 — the chart
  // contradicting the number directly above it. Same absolute-floor mistake
  // already removed from `ahead()`, in the second place it was written.
  it("shows no daily sessions when there are no sessions", async () => {
    const { demoStatsCache } = await import("@/lib/demo/stats");
    const cache = demoStatsCache({ sessions: 0, messages: 0 }, Date.UTC(2026, 7, 17));

    expect(cache.totalSessions).toBe(0);
    expect(cache.dailyActivity.every((d) => d.sessionCount === 0)).toBe(true);
  });

  // The floor still earns its place when there IS activity: a busy demo week
  // should not render empty days just because a low-weight day rounds to 0.
  it("keeps the floor when sessions exist", async () => {
    const { demoStatsCache } = await import("@/lib/demo/stats");
    const cache = demoStatsCache({ sessions: 12, messages: 300 }, Date.UTC(2026, 7, 17));

    expect(cache.dailyActivity.every((d) => d.sessionCount >= 1)).toBe(true);
  });
});

describe("a load in flight across a dispose cannot write its result back", () => {
  /**
   * Codex, PR #455 round 2 — against the dispose-on-config-write that had just
   * fixed the non-racy version of this leak. Clearing a cache says nothing
   * about a loader that is already awaiting: it resolves afterwards and writes
   * under the same mode-agnostic key, so demo requests read real data for the
   * full TTL past a correct guard.
   *
   * Sequenced explicitly rather than with timers — the window is "between the
   * await and the set", and a sleep would only make it likely, not certain.
   */
  it("drops the late write when the cache was cleared mid-load", async () => {
    const { TtlCache } = await import("@/lib/routeCache");
    const cache = new TtlCache<string>({ ttlMs: 120_000 });

    let release!: (v: string) => void;
    const inFlight = cache.getOrLoad("all", () => new Promise<string>((r) => (release = r)));

    cache.dispose(); // the Settings toggle lands while the loader is awaiting
    release("real plan titles");

    await expect(inFlight).resolves.toBe("real plan titles"); // this caller still gets its answer
    expect(cache.get("all")).toBeUndefined(); // ...but nothing was cached for the next one
  });

  // Control: with no dispose, the same sequence DOES cache — otherwise the
  // assertion above would pass against a getOrLoad that never writes at all.
  it("caches normally when nothing cleared it", async () => {
    const { TtlCache } = await import("@/lib/routeCache");
    const cache = new TtlCache<string>({ ttlMs: 120_000 });

    let release!: (v: string) => void;
    const inFlight = cache.getOrLoad("all", () => new Promise<string>((r) => (release = r)));
    release("real plan titles");
    await inFlight;

    expect(cache.get("all")).toBe("real plan titles");
  });

  it("serves a fresh hit without calling the loader", async () => {
    const { TtlCache } = await import("@/lib/routeCache");
    const cache = new TtlCache<string>({ ttlMs: 120_000 });
    cache.set("all", "cached");

    const load = vi.fn(async () => "loaded");
    await expect(cache.getOrLoad("all", load)).resolves.toBe("cached");
    expect(load).not.toHaveBeenCalled();
  });
});
