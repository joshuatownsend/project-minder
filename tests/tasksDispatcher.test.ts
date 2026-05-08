import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
}));

// Mock store functions the dispatcher calls
vi.mock("../src/lib/tasks/store", () => ({
  claimPendingTask: vi.fn().mockResolvedValue(null),
  materializeSchedules: vi.fn().mockResolvedValue(0),
  promoteApprovalTasks: vi.fn().mockResolvedValue(0),
}));

// Mock spawner
vi.mock("../src/lib/tasks/spawner", () => ({
  sweepStalePids: vi.fn(),
  runClassicTask: vi.fn().mockResolvedValue({ taskId: 1, status: "done", durationMs: 100 }),
}));

import { initDispatcher, isDispatcherRunning, getDispatcherStats } from "../src/lib/tasks/dispatcher";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks } from "../src/lib/tasks/store";
import { sweepStalePids } from "../src/lib/tasks/spawner";

// Patch globalThis between tests
function cleanupDispatcher() {
  const g = globalThis as Record<string, unknown>;
  if (g.__minderDispatcher && typeof (g.__minderDispatcher as { dispose?: () => void }).dispose === "function") {
    (g.__minderDispatcher as { dispose: () => void }).dispose();
  }
  delete g.__minderDispatcher;
}

describe("dispatcher singleton", () => {
  beforeEach(() => {
    cleanupDispatcher();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupDispatcher();
    vi.useRealTimers();
  });

  it("initializes when not running", () => {
    expect(isDispatcherRunning()).toBe(false);
    initDispatcher();
    expect(isDispatcherRunning()).toBe(true);
  });

  it("is idempotent — second init call is a no-op", () => {
    initDispatcher();
    initDispatcher();
    expect(isDispatcherRunning()).toBe(true);
    const stats = getDispatcherStats();
    // Only one dispatcher should exist
    expect(stats).not.toBeNull();
  });

  it("dispose() stops the dispatcher", () => {
    initDispatcher();
    expect(isDispatcherRunning()).toBe(true);
    cleanupDispatcher();
    expect(isDispatcherRunning()).toBe(false);
  });

  it("first tick fires after 2s delay", async () => {
    initDispatcher();
    expect(materializeSchedules).not.toHaveBeenCalled();

    // Fast-forward past the 2s initial delay
    await vi.advanceTimersByTimeAsync(2_100);
    expect(materializeSchedules).toHaveBeenCalledOnce();
    expect(promoteApprovalTasks).toHaveBeenCalledOnce();
    expect(sweepStalePids).toHaveBeenCalledOnce();
  });

  it("subsequent ticks fire every 30s", async () => {
    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // first tick
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(30_000); // second tick
    expect(materializeSchedules).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); // third tick
    expect(materializeSchedules).toHaveBeenCalledTimes(2);
  });

  it("claims and runs eligible pending tasks on tick", async () => {
    const { runClassicTask } = await import("../src/lib/tasks/spawner");
    const mockTask = {
      id: 5, title: "x", description: "", status: "running", priority: 3, quadrant: "do",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 0, schedule_id: null,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      consecutive_failures: 0, created_at: new Date().toISOString(),
    };

    vi.mocked(claimPendingTask).mockResolvedValueOnce(mockTask as never).mockResolvedValue(null);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100);
    // Let microtask queue drain so in-flight promises resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(runClassicTask).toHaveBeenCalledWith(mockTask, undefined);
  });

  it("skips dry_run tasks without spawning", async () => {
    const { runClassicTask } = await import("../src/lib/tasks/spawner");
    const dryRunTask = {
      id: 6, title: "dry", description: "", status: "running", priority: 3, quadrant: "do",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 1, schedule_id: null,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      consecutive_failures: 0, created_at: new Date().toISOString(),
    };

    vi.mocked(claimPendingTask).mockResolvedValueOnce(dryRunTask as never).mockResolvedValue(null);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100);

    expect(runClassicTask).not.toHaveBeenCalled();
  });
});
