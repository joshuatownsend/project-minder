import "server-only";
import os from "os";
import path from "path";
import fs from "fs";
import { claimPendingTask, materializeSchedules, promoteApprovalTasks, completeTask } from "./store";
import { runClassicTask, sweepStalePids, type SpawnFn } from "./spawner";
import type { Task } from "./types";

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

declare const globalThis: {
  __minderDispatcher?: DispatcherHandle;
} & typeof global;

export function getDispatcherStats(): DispatcherStats | null {
  return globalThis.__minderDispatcher?.getStats() ?? null;
}

export function isDispatcherRunning(): boolean {
  return !!globalThis.__minderDispatcher;
}

/**
 * Initialize the dispatcher singleton if not already running.
 * Safe to call multiple times — no-ops if already initialized.
 */
export function initDispatcher(spawnFn?: SpawnFn): void {
  if (globalThis.__minderDispatcher) return;

  const startedAt = new Date().toISOString();
  let tickCount = 0;
  let lastTickAt: string | null = null;
  const inFlight = new Map<number, Promise<void>>();

  async function tick() {
    lastTickAt = new Date().toISOString();
    tickCount++;

    writeHeartbeat(lastTickAt, inFlight.size);
    sweepStalePids();

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

      const promise: Promise<void> = runClassicTask(task, spawnFn)
        .then(() => { /* result already written to DB by completeTask/failTask */ })
        .catch((err) => console.error(`[dispatcher] task ${task!.id} spawn error:`, err))
        .finally(() => inFlight.delete(task!.id));

      inFlight.set(task.id, promise);
    }
  }

  const interval = setInterval(() => { tick().catch(console.error); }, TICK_INTERVAL_MS);
  // Run first tick after a short delay so the server is fully initialized
  setTimeout(() => { tick().catch(console.error); }, 2_000);

  globalThis.__minderDispatcher = {
    dispose() {
      clearInterval(interval);
      globalThis.__minderDispatcher = undefined;
    },
    getStats() {
      return { running: inFlight.size, tickCount, lastTickAt, startedAt };
    },
  };
}

function writeHeartbeat(lastTickAt: string, running: number) {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
    fs.writeFileSync(
      HEARTBEAT_PATH,
      JSON.stringify({ lastTickAt, running, pid: process.pid }),
      "utf8"
    );
  } catch {
    // Non-fatal
  }
}
