import "server-only";
import { promisify } from "util";
import { exec } from "child_process";
import { listTrackedPids } from "./spawner";
import { killProcessTree, isWindows } from "../platform";
import { mutateConfig } from "../config";

const execAsync = promisify(exec);

export interface EmergencyStopResult {
  stopped: true;
  processesKilled: number;
  interactiveSpared: number;
  errors: string[];
}

/**
 * Verify a PID is a dispatcher-launched claude process.
 * On Windows: uses `tasklist /FI "PID eq <pid>"` and checks for "claude" in output.
 * On Unix: uses `ps -p <pid> -o command=`.
 * Returns true if confirmed, false if unconfirmed or already dead.
 */
async function isClaudeProcess(pid: number): Promise<boolean> {
  try {
    if (isWindows) {
      const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 5000 });
      return stdout.toLowerCase().includes("claude");
    } else {
      const { stdout } = await execAsync(`ps -p ${pid} -o command=`, { timeout: 5000 });
      return stdout.toLowerCase().includes("claude");
    }
  } catch {
    // Process may already be dead or ps/tasklist unavailable
    return false;
  }
}

/**
 * Emergency stop: kill all dispatcher-spawned Claude processes.
 *
 * Reads PID files from ~/.minder/pids/, verifies each is a claude process
 * (not a user-started session) via tasklist/ps, kills only confirmed ones,
 * and sets emergencyStop=true in .minder.json so the dispatcher loop pauses.
 */
export async function emergencyStop(): Promise<EmergencyStopResult> {
  const pids = listTrackedPids();
  let processesKilled = 0;
  let interactiveSpared = 0;
  const errors: string[] = [];

  const results = await Promise.all(pids.map(async (pid) => ({ pid, confirmed: await isClaudeProcess(pid) })));
  for (const { pid, confirmed } of results) {
    if (confirmed) {
      try {
        await killProcessTree(pid);
        processesKilled++;
      } catch (err) {
        errors.push(`PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      interactiveSpared++;
    }
  }

  // Set emergencyStop flag so the dispatcher gate fires on next tick
  try {
    await mutateConfig((cfg) => { cfg.emergencyStop = true; });
  } catch (err) {
    errors.push(`Config write: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { stopped: true, processesKilled, interactiveSpared, errors };
}

/**
 * Clear the emergency stop flag so the dispatcher resumes spawning on the next tick.
 */
export async function resumeDispatcher(): Promise<void> {
  await mutateConfig((cfg) => { cfg.emergencyStop = false; });
}
