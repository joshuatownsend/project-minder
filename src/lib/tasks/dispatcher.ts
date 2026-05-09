import "server-only";
import os from "os";
import path from "path";
import fs from "fs";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks, completeTask, recordDecision, getTask, updateSwarmStatus } from "./store";
import { runClassicTask, runStreamTask, runWorktreeTask, sweepStalePids, type SpawnFn } from "./spawner";
import type { Task } from "./types";
import type { DecisionEvent } from "./decisionParser";
import { readConfig } from "../config";
import { onTaskCompleteToggleTodo } from "./todoDelegation";

const HEARTBEAT_PATH = path.join(os.homedir(), ".minder", "dispatcher-heartbeat.json");
const TICK_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 3;

interface DispatcherHandle {
  dispose: () => void;
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

      while (inFlight.size < MAX_CONCURRENT) {
        let task: Task | null = null;
        try {
          task = await claimPendingTask();
        } catch (err) {
          console.error("[dispatcher] claimPendingTask error:", err);
          break;
        }
        if (!task) break;

        if (task.dry_run) {
          console.log(`[dispatcher] dry_run task ${task.id} "${task.title}" — skipping spawn`);
          await completeTask(task.id, { output_summary: "dry-run: spawn skipped" }).catch(console.error);
          continue;
        }

        const swarmId = task.swarm_id;

        async function afterComplete(completedTask?: Task): Promise<void> {
          if (completedTask) await onTaskCompleteToggleTodo(completedTask);
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
          promise = runClassicTask(task, spawnFn)
            .then(() => afterComplete())
            .catch((err) => console.error(`[dispatcher] task ${task!.id} spawn error:`, err))
            .finally(() => inFlight.delete(task!.id));
        }

        inFlight.set(task.id, promise);
      }
    } finally {
      tickInProgress = false;
    }
  }

  const interval = setInterval(() => { tick().catch(console.error); }, TICK_INTERVAL_MS);
  const initialTimeout = setTimeout(() => { tick().catch(console.error); }, 2_000);

  g.__minderDispatcher = {
    dispose() {
      clearInterval(interval);
      clearTimeout(initialTimeout);
      g.__minderDispatcher = undefined;
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
