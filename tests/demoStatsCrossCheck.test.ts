import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as nodeFs } from "fs";
import type { MinderConfig } from "@/lib/types";

// Same idiom as demoMode.test.ts — drive the flag through a mocked config read.
vi.mock("@/lib/config", () => ({ readConfig: vi.fn() }));
import { readConfig } from "@/lib/config";
import { getStatsCache, getStatsCacheMtimeMs, crossCheckStats } from "@/lib/scanner/claudeStats";
import { demoStatsCache } from "@/lib/demo/stats";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #421 — a bare `delete process.env.X` in teardown restores this file's own
// assignment and destroys anything it INHERITED, and vitest reuses a worker
// across files, so the erasure outlives this one. Capture and put back instead.
preserveEnvVars(["MINDER_DEMO"]);

const mockConfig = vi.mocked(readConfig);

function configWith(demoFlag: boolean): MinderConfig {
  return {
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    featureFlags: { demoMode: demoFlag },
  } as MinderConfig;
}

const NOW = Date.parse("2026-08-16T12:00:00Z");

describe("demo mode does not read Claude's real stats-cache.json", () => {
  beforeEach(() => {
    delete process.env.MINDER_DEMO;
    mockConfig.mockResolvedValue(configWith(false));
  });
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("getStatsCache() returns null and touches no file under demo mode", async () => {
    process.env.MINDER_DEMO = "1";
    const readFile = vi.spyOn(nodeFs, "readFile");
    const stat = vi.spyOn(nodeFs, "stat");

    expect(await getStatsCache()).toBeNull();

    // The point of the guard is that the real file is never opened — asserting
    // only on the null return would pass even if it were read and discarded.
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("getStatsCacheMtimeMs() reports 0 under demo mode without stat-ing", async () => {
    process.env.MINDER_DEMO = "1";
    const stat = vi.spyOn(nodeFs, "stat");

    expect(await getStatsCacheMtimeMs()).toBe(0);
    expect(stat).not.toHaveBeenCalled();
  });

  it("still reads the real file when demo mode is off", async () => {
    const stat = vi.spyOn(nodeFs, "stat").mockRejectedValue(new Error("nope"));
    // 0 here is the "absent" path, not the demo path — what matters is that the
    // guard let the call through. Without this the demo assertions above would
    // pass against a function that never reads anything in any mode.
    expect(await getStatsCacheMtimeMs()).toBe(0);
    expect(stat).toHaveBeenCalled();
  });
});

describe("demoStatsCache derives a green cross-check from the observed totals", () => {
  it("sits slightly ahead of observed, so drift is small and negative", () => {
    const observed = { sessions: 120, messages: 4_800 };
    const cc = crossCheckStats(demoStatsCache(observed, NOW), observed);

    expect(cc.available).toBe(true);
    // Claude's counter runs a little ahead of ours; observed-minus-claude is
    // therefore a small negative fraction, nothing like the -91%/-100% the
    // capture pipeline refuses to publish.
    expect(cc.sessionDriftRatio).toBeLessThan(0);
    expect(cc.sessionDriftRatio!).toBeGreaterThan(-0.1);
    expect(cc.messageDriftRatio!).toBeGreaterThan(-0.1);
  });

  it("stays green for any plausible observed totals (derivation, not constants)", () => {
    // The regression this guards: replacing the derivation with fixed numbers.
    // Constants tuned for one fixture set go red as soon as either of the two
    // independent demo sources changes.
    // Includes the small-N cases that caught the original `Math.max(1, …)`
    // floor, where a +1 nudge on 1 session rendered as −50%.
    for (const sessions of [1, 2, 7, 63, 400, 5_000]) {
      const observed = { sessions, messages: sessions * 40 };
      const cc = crossCheckStats(demoStatsCache(observed, NOW), observed);
      expect(cc.sessionDriftRatio!).toBeGreaterThan(-0.1);
      expect(cc.sessionDriftRatio!).toBeLessThanOrEqual(0);
      expect(cc.messageDriftRatio!).toBeGreaterThan(-0.1);
    }
  });

  it("reports no message row when the sessions list failed", () => {
    const observed = { sessions: 90, messages: null };
    const cc = crossCheckStats(demoStatsCache(observed, NOW), observed);
    // `crossCheckStats` normalises the absent total to null, and the card hides
    // the Messages row entirely when observed is null.
    expect(cc.claudeMessages).toBeNull();
    expect(cc.messageDriftRatio).toBeNull();
  });

  it("is deterministic — repeated capture runs produce identical fixtures", () => {
    const observed = { sessions: 63, messages: 2_100 };
    expect(demoStatsCache(observed, NOW)).toEqual(demoStatsCache(observed, NOW));
  });

  it("emits well-formed daily activity", () => {
    const days = demoStatsCache({ sessions: 63, messages: 2_100 }, NOW).dailyActivity;
    expect(days).toHaveLength(14);
    expect(days[days.length - 1].date).toBe("2026-08-16");
    for (const d of days) {
      expect(d.sessionCount).toBeGreaterThan(0);
      expect(d.messageCount).toBeGreaterThanOrEqual(0);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(d.date)).toBe(true);
    }
  });
});
