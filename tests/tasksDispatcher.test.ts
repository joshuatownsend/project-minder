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
  completeTask: vi.fn().mockResolvedValue(undefined),
  recordDecision: vi.fn().mockResolvedValue(undefined),
  getTask: vi.fn().mockResolvedValue(null),
  updateSwarmStatus: vi.fn().mockResolvedValue(undefined),
  requeueRunningTask: vi.fn().mockResolvedValue(null),
}));

// Mock the completion hooks so we can assert the dispatcher fires them.
vi.mock("../src/lib/tasks/todoDelegation", () => ({
  onTaskCompleteToggleTodo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tasks/boardDelegation", () => ({
  onTaskCompleteSyncBoard: vi.fn().mockResolvedValue(undefined),
}));

// Mock spawner
vi.mock("../src/lib/tasks/spawner", () => ({
  sweepStalePids: vi.fn(),
  runClassicTask: vi.fn().mockResolvedValue({ taskId: 1, status: "done", durationMs: 100 }),
}));

import { initDispatcher, isDispatcherRunning, getDispatcherStats, stopDispatcher } from "../src/lib/tasks/dispatcher";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks, getTask, requeueRunningTask } from "../src/lib/tasks/store";
import { onTaskCompleteSyncBoard } from "../src/lib/tasks/boardDelegation";
import { onTaskCompleteToggleTodo } from "../src/lib/tasks/todoDelegation";
import { sweepStalePids } from "../src/lib/tasks/spawner";

/** Drain the microtask queue enough times for the classic-completion promise
 *  chain (runClassicTask → getTask → afterComplete → hooks) to settle. */
async function drainMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

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

  it("fires board + TODO completion hooks for a classic task on completion", async () => {
    const classicTask = {
      id: 7, title: "promoted", description: "", status: "running", priority: 3, quadrant: "delegated-todo",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 0, schedule_id: null, swarm_id: null,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      metadata: JSON.stringify({ sourceType: "board-issue", boardIssueId: "i-1111", projectPath: "C:\\dev\\x" }),
      consecutive_failures: 0, created_at: new Date().toISOString(),
    };
    const completedTask = { ...classicTask, status: "done" };

    vi.mocked(claimPendingTask).mockResolvedValueOnce(classicTask as never).mockResolvedValue(null);
    vi.mocked(getTask).mockResolvedValue(completedTask as never);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100);
    await drainMicrotasks();

    // The classic completion path re-reads the Task and feeds it to both hooks.
    expect(getTask).toHaveBeenCalledWith(7);
    expect(onTaskCompleteSyncBoard).toHaveBeenCalledWith(completedTask);
    expect(onTaskCompleteToggleTodo).toHaveBeenCalledWith(completedTask);
  });

  it("stops claiming mid-tick when shut down, and stop() resolves only after the in-flight tick settles (F5)", async () => {
    const { runClassicTask } = await import("../src/lib/tasks/spawner");
    // Gate materializeSchedules so we can flip stopDispatcher() while a tick is
    // in flight — before it reaches the claim loop.
    let releaseMaterialize!: () => void;
    const gate = new Promise<number>((resolve) => {
      releaseMaterialize = () => resolve(0);
    });
    vi.mocked(materializeSchedules).mockReturnValueOnce(gate as never);
    // If a claim were ever attempted it would return a task — proving the guard
    // by its ABSENCE of a call.
    vi.mocked(claimPendingTask).mockResolvedValue({ id: 99 } as never);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // first tick starts, now awaiting the gate
    expect(claimPendingTask).not.toHaveBeenCalled();

    // Shut down mid-tick — sets `stopped` synchronously and drops the handle.
    const settle = stopDispatcher();
    expect(isDispatcherRunning()).toBe(false);

    // Release the gate; the tick resumes, sees `stopped`, and returns before
    // the claim loop. Awaiting settle proves stop() waits for the tick.
    releaseMaterialize();
    await settle;

    expect(claimPendingTask).not.toHaveBeenCalled(); // no new claims after stop
    expect(runClassicTask).not.toHaveBeenCalled(); // and nothing spawned
  });

  it("stop() awaits the REAL in-flight tick even when a later interval overlaps it (F8)", async () => {
    // Gate the first tick so it stays in flight across the next interval fire.
    let releaseMaterialize!: () => void;
    let materializeStarted = false;
    const gate = new Promise<number>((resolve) => {
      releaseMaterialize = () => resolve(0);
    });
    vi.mocked(materializeSchedules).mockImplementation(() => {
      materializeStarted = true;
      return gate as never;
    });

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // tick #1 starts, parks on the gate
    expect(materializeStarted).toBe(true);

    // Fire the 30s interval while tick #1 is still parked — an OVERLAPPING tick.
    // The wrapper must not overwrite currentTick with a no-op early-return
    // promise (tick #2 bails on tickInProgress).
    await vi.advanceTimersByTimeAsync(30_000);

    const settle = stopDispatcher();
    let settled = false;
    void settle.then(() => {
      settled = true;
    });

    // stop() must still be awaiting tick #1 — not the clobbering no-op promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Let tick #1 finish; only now may stop() resolve.
    releaseMaterialize();
    await settle;
    expect(settled).toBe(true);
  });

  it("requeues a task to pending when shutdown races the claim (F9)", async () => {
    const { runClassicTask } = await import("../src/lib/tasks/spawner");
    const claimedTask = {
      id: 42, title: "raced", description: "", status: "running", priority: 3, quadrant: "do",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 0, schedule_id: null, swarm_id: null,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      metadata: null, consecutive_failures: 0, created_at: new Date().toISOString(),
    };
    // Gate the claim so stop() can flip `stopped` after the row is claimed
    // (claimPendingTask has already set it 'running') but before we spawn.
    let releaseClaim!: (t: unknown) => void;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    vi.mocked(claimPendingTask).mockReturnValueOnce(claimGate as never);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // tick reaches the claim await
    expect(claimPendingTask).toHaveBeenCalledTimes(1);

    const settle = stopDispatcher();
    releaseClaim(claimedTask); // claim returns; post-claim guard sees `stopped`
    await settle;

    expect(requeueRunningTask).toHaveBeenCalledWith(42); // requeued, not stranded
    expect(runClassicTask).not.toHaveBeenCalled(); // and not spawned
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
