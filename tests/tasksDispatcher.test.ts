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
  failTask: vi.fn().mockResolvedValue({ id: 0, status: "failed" }),
  listRunningTasks: vi.fn().mockResolvedValue([]),
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
  getLiveDispatchSnapshot: vi.fn(() => ({ taskIds: new Set<number>(), hasUnmappedLive: false })),
}));

import { initDispatcher, isDispatcherRunning, getDispatcherStats, stopDispatcher, reconcileInterruptedTasks } from "../src/lib/tasks/dispatcher";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks, getTask, requeueRunningTask, failTask, listRunningTasks, updateSwarmStatus } from "../src/lib/tasks/store";
import { onTaskCompleteSyncBoard } from "../src/lib/tasks/boardDelegation";
import { onTaskCompleteToggleTodo } from "../src/lib/tasks/todoDelegation";
import { sweepStalePids, getLiveDispatchSnapshot } from "../src/lib/tasks/spawner";

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

  it("skips dispatcher completion bookkeeping when a spawned task finishes after shutdown (F10)", async () => {
    const { runClassicTask } = await import("../src/lib/tasks/spawner");
    const task = {
      id: 77, title: "long-runner", description: "", status: "running", priority: 3, quadrant: "do",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 0, schedule_id: null, swarm_id: null,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      metadata: null, consecutive_failures: 0, created_at: new Date().toISOString(),
    };
    vi.mocked(claimPendingTask).mockResolvedValueOnce(task as never).mockResolvedValue(null);

    // Gate the spawn so the child "exits" only AFTER we shut down.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise((resolve) => {
      releaseSpawn = () => resolve({ taskId: 77, status: "done", durationMs: 1 });
    });
    vi.mocked(runClassicTask).mockReturnValueOnce(spawnGate as never);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // tick claims + spawns (gated), then finishes
    expect(runClassicTask).toHaveBeenCalledTimes(1);

    // Shut down while the spawn is still in flight.
    await stopDispatcher();

    // Child exits post-shutdown → completion continuation must no-op: no row
    // re-read, no board/TODO sync, no throw.
    releaseSpawn();
    await drainMicrotasks();

    expect(getTask).not.toHaveBeenCalled();
    expect(onTaskCompleteSyncBoard).not.toHaveBeenCalled();
    expect(onTaskCompleteToggleTodo).not.toHaveBeenCalled();
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

  it("runs the interrupted-task reconcile on every tick (F15 cadence)", async () => {
    vi.mocked(listRunningTasks).mockResolvedValue([]);

    initDispatcher(); // boot reconcile fires once
    await drainMicrotasks();
    const afterBoot = vi.mocked(listRunningTasks).mock.calls.length;
    expect(afterBoot).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(2_100); // first tick
    const afterTick1 = vi.mocked(listRunningTasks).mock.calls.length;
    expect(afterTick1).toBeGreaterThan(afterBoot);

    await vi.advanceTimersByTimeAsync(30_000); // second tick
    expect(vi.mocked(listRunningTasks).mock.calls.length).toBeGreaterThan(afterTick1);
  });

  it("stops reconciling once stopped (F15 — no reconcile during shutdown)", async () => {
    vi.mocked(listRunningTasks).mockResolvedValue([]);

    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100); // one tick reconcile
    const before = vi.mocked(listRunningTasks).mock.calls.length;

    cleanupDispatcher(); // dispose → stopped = true, timers cleared

    await vi.advanceTimersByTimeAsync(90_000); // would be several ticks
    expect(vi.mocked(listRunningTasks).mock.calls.length).toBe(before);
  });
});

describe("reconcileInterruptedTasks (F12 boot-time running-row reconcile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listRunningTasks).mockResolvedValue([]);
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>(), hasUnmappedLive: false });
    vi.mocked(failTask).mockResolvedValue({ id: 0, status: "failed" } as never);
  });

  function runningRow(id: number, swarmId: number | null = null) {
    return {
      id, title: `t${id}`, description: "", status: "running", priority: 3, quadrant: "do",
      assigned_skill: null, model: null, execution_mode: "classic", scheduled_for: null,
      requires_approval: 0, risk_level: "low", dry_run: 0, schedule_id: null, swarm_id: swarmId,
      approved_at: null, session_id: null, started_at: null, completed_at: null,
      duration_ms: null, cost_usd: null, output_summary: null, error_message: null,
      metadata: null, consecutive_failures: 0, created_at: new Date().toISOString(),
    };
  }

  it("fails a 'running' row whose child is gone, and leaves an alive one untouched", async () => {
    const gone = runningRow(10);
    const alive = runningRow(11);
    vi.mocked(listRunningTasks).mockResolvedValue([gone, alive] as never);
    // Only task 11 still has a live dispatched child.
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>([11]), hasUnmappedLive: false });

    await reconcileInterruptedTasks();

    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith(10, expect.objectContaining({
      error_message: expect.stringContaining("exited unmonitored"),
    }));
    // The alive row is left as-is.
    expect(failTask).not.toHaveBeenCalledWith(11, expect.anything());
  });

  it("refreshes swarm status for an interrupted swarm member", async () => {
    vi.mocked(listRunningTasks).mockResolvedValue([runningRow(20, 99)] as never);
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>(), hasUnmappedLive: false });

    await reconcileInterruptedTasks();

    expect(failTask).toHaveBeenCalledWith(20, expect.anything());
    expect(updateSwarmStatus).toHaveBeenCalledWith(99);
  });

  it("no-ops when there are no running rows", async () => {
    vi.mocked(listRunningTasks).mockResolvedValue([]);
    await reconcileInterruptedTasks();
    expect(getLiveDispatchSnapshot).not.toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });

  it("never throws even if the store read fails", async () => {
    vi.mocked(listRunningTasks).mockRejectedValue(new Error("db down"));
    await expect(reconcileInterruptedTasks()).resolves.toBeUndefined();
  });

  it("defers (does NOT fail) unmatched rows while live legacy/corrupt markers exist (F13)", async () => {
    // A running row we can't match to a live NEW-format marker, but a live
    // legacy/unknown marker is present — its task id is unknowable, so it might
    // be this row's process. Must not fail it.
    vi.mocked(listRunningTasks).mockResolvedValue([runningRow(30), runningRow(31)] as never);
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>(), hasUnmappedLive: true });

    await reconcileInterruptedTasks();

    expect(failTask).not.toHaveBeenCalled();
    expect(updateSwarmStatus).not.toHaveBeenCalled();
  });

  it("still fails an unmatched row when a matched live marker coexists but no unmapped markers (F13)", async () => {
    // task 40 has a live NEW marker (left); task 41 has none and there are no
    // unmapped live markers → provably dead → failed.
    vi.mocked(listRunningTasks).mockResolvedValue([runningRow(40), runningRow(41)] as never);
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>([40]), hasUnmappedLive: false });

    await reconcileInterruptedTasks();

    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith(41, expect.anything());
    expect(failTask).not.toHaveBeenCalledWith(40, expect.anything());
  });

  it("skips rows this instance is actively supervising (F15 race-avoidance)", async () => {
    // 50 is in the supervised (inFlight) set — even with no live marker (its
    // marker may have just been deleted before completeTask runs) it must NOT
    // be failed. 51 is unsupervised and dead → failed.
    vi.mocked(listRunningTasks).mockResolvedValue([runningRow(50), runningRow(51)] as never);
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>(), hasUnmappedLive: false });

    await reconcileInterruptedTasks(new Set<number>([50]));

    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith(51, expect.anything());
    expect(failTask).not.toHaveBeenCalledWith(50, expect.anything());
  });

  it("resolves a preserved-alive row only once its marker PID goes dead (F15)", async () => {
    vi.mocked(listRunningTasks).mockResolvedValue([runningRow(60)] as never);

    // First pass: child still alive → left running, not failed.
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>([60]), hasUnmappedLive: false });
    await reconcileInterruptedTasks();
    expect(failTask).not.toHaveBeenCalled();

    // Later pass: marker PID now dead → resolved with the "exited unmonitored" reason.
    vi.mocked(getLiveDispatchSnapshot).mockReturnValue({ taskIds: new Set<number>(), hasUnmappedLive: false });
    await reconcileInterruptedTasks();
    expect(failTask).toHaveBeenCalledWith(60, expect.objectContaining({
      error_message: expect.stringContaining("exited unmonitored"),
    }));
  });
});
