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
  setCachedScan: vi.fn(),
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

import {
  shouldBootstrap,
  shouldInstallServiceLifecycle,
  runBootstrap,
  _resetBootstrapForTesting,
} from "@/lib/bootstrap";
import { demoMode } from "@/lib/demo/demoMode";
import { probeInitStatus } from "@/lib/data";
import { scanAllProjects } from "@/lib/scanner";
import { setCachedScan } from "@/lib/cache";
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

    expect(scanAllProjects).not.toHaveBeenCalled();
    expect(manualStepsWatcher.init).not.toHaveBeenCalled();
  });

  it("skips every subsystem in demo mode, even when gated on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(demoMode).mockResolvedValue(true);

    await runBootstrap();

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

    expect(enqueueProjectCaches).toHaveBeenCalledTimes(1);
    expect(enqueueProjectCaches).toHaveBeenCalledWith(
      [{ slug: "demo-app", path: "C:\\dev\\demo-app" }],
      {}
    );
  });

  it("is idempotent across multiple register() calls (dev HMR can fire register() more than once)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await runBootstrap();
    await runBootstrap();
    await runBootstrap();

    expect(scanAllProjects).toHaveBeenCalledTimes(1);
    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it("re-runs after _resetBootstrapForTesting() clears the guard (test-only escape hatch)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await runBootstrap();
    expect(scanAllProjects).toHaveBeenCalledTimes(1);

    _resetBootstrapForTesting();
    await runBootstrap();
    expect(scanAllProjects).toHaveBeenCalledTimes(2);
  });

  it("one subsystem failing does not prevent the others from starting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(scanAllProjects).mockRejectedValueOnce(new Error("scan boom"));

    await expect(runBootstrap()).resolves.not.toThrow();

    expect(manualStepsWatcher.init).toHaveBeenCalledTimes(1);
    expect(mcpConfigWatcher.ensureStarted).toHaveBeenCalledTimes(1);
  });
});
