import "server-only";
import os from "os";
import path from "path";
import fs from "fs";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks, completeTask, recordDecision, getTask, updateSwarmStatus, requeueRunningTask } from "./store";
import { runClassicTask, runStreamTask, runWorktreeTask, sweepStalePids, type SpawnFn } from "./spawner";
import type { Task } from "./types";
import type { DecisionEvent } from "./decisionParser";
import { readConfig } from "../config";
import { onTaskCompleteToggleTodo } from "./todoDelegation";
import { onTaskCompleteSyncBoard } from "./boardDelegation";

const HEARTBEAT_PATH = path.join(os.homedir(), ".minder", "dispatcher-heartbeat.json");
const TICK_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 3;

interface DispatcherHandle {
  dispose: () => void;
  /** Like {@link dispose} but returns a promise that settles once any in-flight
   *  tick has finished — so a shutdown disposer can await a truthful teardown. */
  stop: () => Promise<void>;
  getStats: () => DispatcherStats;
}

interface DispatcherStats {
  running: number;
  tickCount: number;
  lastTickAt: string | null;
  startedAt: string;
}

const g = globalThis as unknown as { __minderDispatcher?: DispatcherHandle };

export function getDispatcherStats(): DispatcherStats | null {
  return g.__minderDispatcher?.getStats() ?? null;
}

export function isDispatcherRunning(): boolean {
  return !!g.__minderDispatcher;
}

/**
 * Stop the dispatcher singleton if running (A2 graceful shutdown): sets a
 * `stopped` flag synchronously (so a tick already mid-flight claims/spawns no
 * further work — see the guards in `tick()`), clears the tick interval +
 * pending initial-tick timeout, drops the global handle, and returns a promise
 * that resolves once any in-flight tick has settled. Idempotent — resolves
 * immediately when the dispatcher isn't running. Already-spawned task
 * processes are not force-killed here; they detach and are reconciled/swept on
 * the next boot.
 */
export function stopDispatcher(): Promise<void> {
  const handle = g.__minderDispatcher;
  if (!handle) return Promise.resolve();
  return handle.stop();
}

/**
 * Initialize the dispatcher singleton if not already running.
 * Safe to call multiple times — no-ops if already initialized.
 */
export function initDispatcher(spawnFn?: SpawnFn): void {
  if (g.__minderDispatcher) return;

  try { fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true }); } catch { /* non-fatal */ }

  const startedAt = new Date().toISOString();
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let tickInProgress = false;
  // Set synchronously by stop()/dispose(). A tick that's mid-flight when
  // shutdown arrives checks this at each claim/spawn point and bails, so it
  // can't claim or spawn new task work while the shutdown disposers proceed
  // toward closing tasks.db.
  let stopped = false;
  // The most recent tick's promise, so stop() can await an in-flight tick's
  // completion (bounded by the shutdown deadline the lifecycle registry caps).
  let currentTick: Promise<void> | null = null;
  const inFlight = new Map<number, Promise<void>>();

  async function handleDecision(taskId: number, event: DecisionEvent): Promise<void> {
    try {
      // Fetch the current session_id (may have been written by the stream-init event).
      const task = await getTask(taskId).catch(() => null);
      await recordDecision(taskId, task?.session_id ?? null, event.kind, event.prompt, event.choices);
    } catch (err) {
      console.error(`[dispatcher] recordDecision failed for task ${taskId}:`, err);
    }
  }

  async function tick() {
    if (tickInProgress) return;
    if (stopped) return;
    tickInProgress = true;
    try {
      lastTickAt = new Date().toISOString();
      tickCount++;

      sweepStalePids();

      // Emergency stop gate — skip spawning but keep heartbeat + sweep running
      let cfg = null;
      try {
        cfg = await readConfig();
      } catch {
        // Config read failure is non-fatal — proceed without gate check
      }
      const paused = !!cfg?.emergencyStop;
      writeHeartbeat(lastTickAt, inFlight.size, paused);
      if (paused) return;

      try {
        await materializeSchedules();
      } catch (err) {
        console.error("[dispatcher] schedule materialization error:", err);
      }

      try {
        await promoteApprovalTasks();
      } catch (err) {
        console.error("[dispatcher] promoteApprovalTasks error:", err);
      }

      // Don't claim/spawn any new work once shutdown has begun. Checked here
      // (a tick can reach this point after several awaits during which stop()
      // may have flipped) and again below right after each claim.
      if (stopped) return;

      while (inFlight.size < MAX_CONCURRENT) {
        if (stopped) break; // no new claims after stop
        let task: Task | null = null;
        try {
          task = await claimPendingTask();
        } catch (err) {
          console.error("[dispatcher] claimPendingTask error:", err);
          break;
        }
        if (!task) break;
        // stop() may have flipped during the claim await. claimPendingTask()
        // already flipped this row to 'running', and crash recovery only sweeps
        // PID files (not never-spawned rows) — so requeue it back to 'pending'
        // rather than abandon it stranded 'running'. Guarded so a store failure
        // can't throw into the tick; the tasks.db disposer runs after this, so
        // the write lands before the DB closes.
        if (stopped) {
          const claimedId = task.id;
          await requeueRunningTask(claimedId).catch((err) =>
            console.error(`[dispatcher] requeue on shutdown failed for task ${claimedId}:`, err)
          );
          break;
        }

        if (task.dry_run) {
          console.log(`[dispatcher] dry_run task ${task.id} "${task.title}" — skipping spawn`);
          await completeTask(task.id, { output_summary: "dry-run: spawn skipped" }).catch(console.error);
          continue;
        }

        const swarmId = task.swarm_id;

        async function afterComplete(completedTask?: Task): Promise<void> {
          if (completedTask) {
            // TODO-sourced tasks tick their TODO.md line (guarded by
            // sourceFile==="TODO.md"); board-sourced tasks flip their issue to
            // done. Both are best-effort and mutually exclusive by metadata.
            await onTaskCompleteToggleTodo(completedTask);
            await onTaskCompleteSyncBoard(completedTask);
          }
          if (swarmId != null) {
            await updateSwarmStatus(swarmId).catch((err) =>
              console.error(`[dispatcher] updateSwarmStatus failed for swarm ${swarmId}:`, err)
            );
          }
        }

        let worktreePath: string | undefined;
        try {
          worktreePath = (JSON.parse(task.metadata ?? "{}") as { worktreePath?: string }).worktreePath;
        } catch { /* metadata not JSON */ }
        const isWorktree = task.swarm_id != null && !!worktreePath;

        let promise: Promise<void>;
        if (isWorktree) {
          promise = runWorktreeTask(task, spawnFn, handleDecision, afterComplete)
            .then(() => {})
            .catch((err) => console.error(`[dispatcher] task ${task!.id} spawn error:`, err))
            .finally(() => inFlight.delete(task!.id));
        } else if (task.execution_mode === "stream") {
          promise = runStreamTask(task, spawnFn, handleDecision, afterComplete)
            .then(() => {})
            .catch((err) => console.error(`[dispatcher] task ${task!.id} spawn error:`, err))
            .finally(() => inFlight.delete(task!.id));
        } else {
          // Classic mode: runClassicTask returns a RunTaskResult, not the Task
          // row, and (unlike stream/worktree) takes no onComplete callback — so
          // re-read the completed Task and hand it to afterComplete. Without this
          // the completion hooks (board sync / TODO toggle) never fire for classic
          // tasks, which are the default for promoteBoardIssueToTask + delegateTodo.
          promise = runClassicTask(task, spawnFn)
            .then(async () => {
              const completedTask = await getTask(task!.id).catch(() => null);
              await afterComplete(completedTask ?? undefined);
            })
            .catch((err) => console.error(`[dispatcher] task ${task!.id} spawn error:`, err))
            .finally(() => inFlight.delete(task!.id));
        }

        inFlight.set(task.id, promise);
      }
    } finally {
      tickInProgress = false;
    }
  }

  // Only publish `currentTick` when a tick actually ENTERS. If a prior tick
  // overran the interval (still in flight) or we're shutting down, skip —
  // otherwise the overlapping invocation's no-op early-return promise would
  // clobber `currentTick`, and stop() would await that already-resolved
  // promise instead of the real in-flight tick.
  function scheduleTick(): void {
    if (tickInProgress || stopped) return;
    currentTick = tick().catch(console.error);
  }
  const interval = setInterval(scheduleTick, TICK_INTERVAL_MS);
  const initialTimeout = setTimeout(scheduleTick, 2_000);

  function teardown(): void {
    stopped = true; // synchronous: an in-flight tick sees this at its next guard
    clearInterval(interval);
    clearTimeout(initialTimeout);
    g.__minderDispatcher = undefined;
  }

  g.__minderDispatcher = {
    dispose() {
      teardown();
    },
    stop() {
      teardown();
      // Await the in-flight tick (if any) so callers see a truthful teardown.
      return currentTick ?? Promise.resolve();
    },
    getStats() {
      return { running: inFlight.size, tickCount, lastTickAt, startedAt };
    },
  };
}

function writeHeartbeat(lastTickAt: string, running: number, paused = false) {
  try {
    fs.writeFileSync(
      HEARTBEAT_PATH,
      JSON.stringify({ lastTickAt, running, pid: process.pid, paused }),
      "utf8"
    );
  } catch {
    // Non-fatal
  }
}
