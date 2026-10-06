import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock every subsystem bootstrap.ts touches so runBootstrap() tests exercise
// only its own gating/orchestration logic — no real fs/network/git side
// effects. Each mock is a spy so tests can assert call counts.
vi.mock("@/lib/demo/demoMode", () => ({
  demoMode: vi.fn(),
}));
vi.mock("@/lib/data", () => ({
  probeInitStatus: vi.fn().mockResolvedValue({
    state: "success",
    attempts: 1,
    quarantineRuns: 0,
    failedAt: null,
    lastError: null,
  }),
}));
vi.mock("@/lib/scanner", () => ({
  scanAllProjects: vi.fn().mockResolvedValue({
    projects: [],
    portConflicts: [],
    hiddenCount: 0,
    scannedAt: "2026-01-01T00:00:00.000Z",
    catalogLintFindings: [],
  }),
}));
vi.mock("@/lib/cache", () => ({
  // true = the cache accepted (stored) the scan; false = refused it as stale (#609).
  setCachedScan: vi.fn(() => true),
  getCachedScan: vi.fn(),
  invalidateCache: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn().mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    pinnedSlugs: [],
    featureFlags: {},
  }),
  getDevRoots: vi.fn().mockReturnValue(["C:\\dev"]),
}));
vi.mock("@/lib/projectCacheEnqueue", () => ({
  enqueueProjectCaches: vi.fn(),
}));
vi.mock("@/lib/manualStepsWatcher", () => ({
  manualStepsWatcher: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/lib/mcpConfigWatcher", () => ({
  mcpConfigWatcher: { ensureStarted: vi.fn() },
}));
vi.mock("@/lib/mcpHealthEnqueue", () => ({
  enqueueMcpHealth: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/claudeStatus/cache", () => ({
  getCurrentStatus: vi.fn().mockResolvedValue({ source: "live" }),
}));
// Real lifecycle, except `isShuttingDown` is a spy: one test makes it throw from
// inside the detached boot sequence, where no step's own try/catch covers it.
vi.mock("@/lib/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle")>()),
  isShuttingDown: vi.fn(() => false),
}));

import {
  shouldBootstrap,
  shouldInstallServiceLifecycle,
  runBootstrap,
  awaitBootSteps,
  _resetBootstrapForTesting,
} from "@/lib/bootstrap";
import { demoMode } from "@/lib/demo/demoMode";
import { probeInitStatus } from "@/lib/data";
import { isShuttingDown } from "@/lib/lifecycle";
import { scanAllProjects } from "@/lib/scanner";
import { setCachedScan, getCachedScan } from "@/lib/cache";
import { readConfig } from "@/lib/config";
import { enqueueProjectCaches } from "@/lib/projectCacheEnqueue";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import { mcpConfigWatcher } from "@/lib/mcpConfigWatcher";
import { enqueueMcpHealth } from "@/lib/mcpHealthEnqueue";
import { getCurrentStatus } from "@/lib/claudeStatus/cache";
import type { ProjectData } from "@/lib/types";

describe("shouldBootstrap (pure gating)", () => {
  it("defaults ON when NODE_ENV=production", () => {
    expect(shouldBootstrap({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("defaults OFF when NODE_ENV=development (no full scan on every dev restart)", () => {
    expect(shouldBootstrap({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("defaults OFF when NODE_ENV is unset (e.g. under vitest)", () => {
    expect(shouldBootstrap({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("MINDER_BOOTSTRAP=1 opts in during development", () => {
    expect(
      shouldBootstrap({ NODE_ENV: "development", MINDER_BOOTSTRAP: "1" } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("MINDER_BOOTSTRAP=0 disables it in production", () => {
    expect(
      shouldBootstrap({ NODE_ENV: "production", MINDER_BOOTSTRAP: "0" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("never bootstraps inside next build workers, even with MINDER_BOOTSTRAP=1 (#312)", () => {
    expect(
      shouldBootstrap({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      shouldBootstrap({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
        MINDER_BOOTSTRAP: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("MINDER_BOOTSTRAP=0 wins even alongside MINDER_BOOTSTRAP=1 (checked first)", () => {
    // Can't literally be both at once, but this documents precedence: the "0"
    // check runs before the "1" check, so an off-override always wins.
    expect(
      shouldBootstrap({
        NODE_ENV: "production",
        MINDER_BOOTSTRAP: "0",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("shouldInstallServiceLifecycle (lifecycle plumbing gate)", () => {
  it("installs when collectors would run (production)", () => {
    expect(
      shouldInstallServiceLifecycle({ NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("STILL installs with MINDER_BOOTSTRAP=0 when a supervisor requested the control channel", () => {
    // The regression this fixes: a tray-spawned sidecar with collectors opted
    // out must still get the stdin control channel + signal handlers, so Quit
    // triggers a clean shutdown instead of the 6s force-kill.
    expect(
      shouldInstallServiceLifecycle({
        NODE_ENV: "production",
        MINDER_BOOTSTRAP: "0",
        MINDER_CONTROL_STDIN: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("installs in dev when a supervisor is present (MINDER_CONTROL_STDIN=1)", () => {
    expect(
      shouldInstallServiceLifecycle({
        NODE_ENV: "development",
        MINDER_CONTROL_STDIN: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("does NOT install for plain dev (no collectors, no supervisor)", () => {
    expect(
      shouldInstallServiceLifecycle({ NODE_ENV: "development" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("does NOT install with MINDER_BOOTSTRAP=0 and no supervisor", () => {
    expect(
      shouldInstallServiceLifecycle({
        NODE_ENV: "production",
        MINDER_BOOTSTRAP: "0",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("runBootstrap (orchestration + idempotency)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBootstrapForTesting();
    vi.mocked(demoMode).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing when gating says no (dev, no opt-in)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MINDER_BOOTSTRAP", undefined);

    await runBootstrap();
    await awaitBootSteps();

    expect(scanAllProjects).not.toHaveBeenCalled();
    expect(manualStepsWatcher.init).not.toHaveBeenCalled();
  });

  it("skips every subsystem in demo mode, even when gated on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(demoMode).mockResolvedValue(true);

    await runBootstrap();
    await awaitBootSteps();

    expect(probeInitStatus).not.toHaveBeenCalled();
    expect(scanAllProjects).not.toHaveBeenCalled();
    expect(manualStepsWatcher.init).not.toHaveBeenCalled();
    expect(mcpConfigWatcher.ensureStarted).not.toHaveBeenCalled();
    expect(enqueueMcpHealth).not.toHaveBeenCalled();
    expect(getCurrentStatus).not.toHaveBeenCalled();
  });

  it("starts every subsystem exactly once when gated on and not in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await runBootstrap();
    await awaitBootSteps();

    expect(probeInitStatus).toHaveBeenCalledTimes(1);
    expect(scanAllProjects).toHaveBeenCalledTimes(1);
    expect(setCachedScan).toHaveBeenCalledTimes(1);
    expect(enqueueProjectCaches).toHaveBeenCalledTimes(0); // no-op: scan returned zero projects
    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
    expect(getCurrentStatus).toHaveBeenCalledTimes(1);
  });

  it("skips the mcpConfigWatcher and mcpHealthCache when the mcpHealth flag is off (F1/F2 follow-up)", async () => {
    // Codex P2 finding on A1: bootstrap started `mcpConfigWatcher` unconditionally,
    // while GET /api/mcp-health (the route it mirrors) returns before starting it
    // when the `mcpHealth` flag is off. Both boot steps must gate on the same flag.
    // `readConfig` is called 4 times per runBootstrap() (scan, mcpConfigWatcher,
    // mcpHealthCache, claudeStatus) — queue the override for each via
    // `mockResolvedValueOnce` (rather than a persistent `mockResolvedValue`) so
    // it drains after this test and can't leak into later tests.
    vi.stubEnv("NODE_ENV", "production");
    const cfg = {
      statuses: {},
      hidden: [],
      portOverrides: {},
      devRoot: "C:\\dev",
      pinnedSlugs: [],
      featureFlags: { mcpHealth: false },
    };
    vi.mocked(readConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    await runBootstrap();
    await awaitBootSteps();

    expect(mcpConfigWatcher.ensureStarted).not.toHaveBeenCalled();
    expect(enqueueMcpHealth).not.toHaveBeenCalled();
  });

  it("starts the mcpConfigWatcher and enqueues mcpHealthCache when the mcpHealth flag is explicitly on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const cfg = {
      statuses: {},
      hidden: [],
      portOverrides: {},
      devRoot: "C:\\dev",
      pinnedSlugs: [],
      featureFlags: { mcpHealth: true },
    };
    vi.mocked(readConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    await runBootstrap();
    await awaitBootSteps();

    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
    expect(enqueueMcpHealth).toHaveBeenCalledTimes(1);
    expect(enqueueMcpHealth).toHaveBeenCalledWith({ mcpHealth: true });
  });

  it("enqueues project caches when the scan returns projects", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(scanAllProjects).mockResolvedValueOnce({
      projects: [{ slug: "demo-app", path: "C:\\dev\\demo-app" }] as unknown as ProjectData[],
      portConflicts: [],
      hiddenCount: 0,
      scannedAt: "2026-01-01T00:00:00.000Z",
      catalogLintFindings: [],
    });

    await runBootstrap();
    await awaitBootSteps();

    expect(enqueueProjectCaches).toHaveBeenCalledTimes(1);
    expect(enqueueProjectCaches).toHaveBeenCalledWith(
      [{ slug: "demo-app", path: "C:\\dev\\demo-app" }],
      {}
    );
  });

  it("is idempotent across multiple register() calls (dev HMR can fire register() more than once)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await runBootstrap();
    await awaitBootSteps();
    await runBootstrap();
    await awaitBootSteps();
    await runBootstrap();
    await awaitBootSteps();

    expect(scanAllProjects).toHaveBeenCalledTimes(1);
    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it("re-runs after _resetBootstrapForTesting() clears the guard (test-only escape hatch)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await runBootstrap();
    await awaitBootSteps();
    expect(scanAllProjects).toHaveBeenCalledTimes(1);

    _resetBootstrapForTesting();
    await runBootstrap();
    await awaitBootSteps();
    expect(scanAllProjects).toHaveBeenCalledTimes(2);
  });

  // Next holds every request until register() resolves, so anything runBootstrap
  // awaits is time /api/health answers nothing (the tray's "slow to respond").
  it("returns once the DB is probed, without waiting for the project scan", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let finishScan!: () => void;
    vi.mocked(scanAllProjects).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishScan = () =>
            resolve({
              projects: [],
              portConflicts: [],
              hiddenCount: 0,
              scannedAt: "2026-01-01T00:00:00.000Z",
              catalogLintFindings: [],
            });
        })
    );

    await runBootstrap(); // would hang here if the scan were still on the critical path

    expect(probeInitStatus).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(scanAllProjects).toHaveBeenCalledTimes(1));
    // Scan still pending: nothing downstream of it has started.
    expect(manualStepsWatcher.init).not.toHaveBeenCalled();
    expect(getCurrentStatus).not.toHaveBeenCalled();

    finishScan();
    await awaitBootSteps();

    expect(setCachedScan).toHaveBeenCalledTimes(1);
    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(getCurrentStatus).toHaveBeenCalledTimes(1);
  });

  it("does not let a failure in the detached steps escape as an unhandled rejection", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // 1st call: the check right after bootDb in runBootstrap. 2nd: inside the detached
    // sequence, outside every step's own try/catch, so only the outer .catch covers it.
    vi.mocked(isShuttingDown).mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error("boom outside any step");
    });

    await runBootstrap();
    await expect(awaitBootSteps()).resolves.toBeUndefined();
  });

  // A scan overtaken by an invalidation is refused by the cache. Warming the git/GitHub queues
  // from it would dedupe the fresh enqueue by slug and keep old-path data for the TTL (Codex, #609).
  it("does not warm project caches from a boot scan the cache refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(scanAllProjects).mockResolvedValueOnce({
      projects: [{ slug: "old-path", path: "C:\\dev\\old" }] as unknown as ProjectData[],
      portConflicts: [], hiddenCount: 0, scannedAt: "2026-01-01T00:00:00.000Z", catalogLintFindings: [],
    });
    vi.mocked(setCachedScan).mockReturnValueOnce(false);
    vi.mocked(getCachedScan).mockReturnValue(null);

    await runBootstrap();
    await awaitBootSteps();

    expect(enqueueProjectCaches).not.toHaveBeenCalled();
  });

  it("warms project caches from the newer scan when the boot scan was refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(scanAllProjects).mockResolvedValueOnce({
      projects: [{ slug: "old-path", path: "C:\\dev\\old" }] as unknown as ProjectData[],
      portConflicts: [], hiddenCount: 0, scannedAt: "2026-01-01T00:00:00.000Z", catalogLintFindings: [],
    });
    vi.mocked(setCachedScan).mockReturnValueOnce(false);
    vi.mocked(getCachedScan).mockReturnValue({
      projects: [{ slug: "new-path", path: "C:\\dev\\new" }] as unknown as ProjectData[],
      portConflicts: [], hiddenCount: 0, scannedAt: "2026-01-02T00:00:00.000Z", catalogLintFindings: [],
    });

    await runBootstrap();
    await awaitBootSteps();

    expect(enqueueProjectCaches).toHaveBeenCalledTimes(1);
    expect(enqueueProjectCaches).toHaveBeenCalledWith(
      [{ slug: "new-path", path: "C:\\dev\\new" }],
      {}
    );
  });

  it("one subsystem failing does not prevent the others from starting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(scanAllProjects).mockRejectedValueOnce(new Error("scan boom"));

    await expect(runBootstrap()).resolves.not.toThrow();
    await awaitBootSteps();

    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
  });
});
