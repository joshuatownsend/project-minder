import "server-only";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import type { Task } from "./types";
import { completeTask, failTask } from "./store";
import { isWindows } from "../platform";

const PID_DIR = path.join(os.homedir(), ".minder", "pids");

export type SpawnFn = typeof spawn;

function ensurePidDir() {
  fs.mkdirSync(PID_DIR, { recursive: true });
}

function writePidFile(pid: number) {
  try {
    ensurePidDir();
    fs.writeFileSync(path.join(PID_DIR, String(pid)), String(pid), "utf8");
  } catch {
    // Non-fatal — PID files are best-effort for emergency stop
  }
}

function deletePidFile(pid: number) {
  try {
    fs.unlinkSync(path.join(PID_DIR, String(pid)));
  } catch {
    // Already gone — ignore
  }
}

/**
 * Scan PID_DIR and unlink files for processes that are no longer alive.
 * Called at the start of each dispatcher tick.
 */
export function sweepStalePids(): void {
  try {
    ensurePidDir();
    const files = fs.readdirSync(PID_DIR);
    for (const f of files) {
      const pid = parseInt(f, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        fs.unlinkSync(path.join(PID_DIR, f));
        continue;
      }
      try {
        process.kill(pid, 0); // throws ESRCH if dead (works on Windows + Unix)
      } catch {
        fs.unlinkSync(path.join(PID_DIR, f));
      }
    }
  } catch {
    // PID dir unreadable — ignore
  }
}

/** List PIDs currently tracked in PID_DIR. Used by emergency stop (Wave 9.2). */
export function listTrackedPids(): number[] {
  try {
    ensurePidDir();
    return fs
      .readdirSync(PID_DIR)
      .map((f) => parseInt(f, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export interface RunTaskResult {
  taskId: number;
  status: "done" | "failed";
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * Spawn `claude -p "<prompt>"` for the task (classic mode).
 * Writes a PID marker file while the child is alive.
 * Updates the task row on completion via completeTask() / failTask().
 */
export async function runClassicTask(
  task: Task,
  spawnFn: SpawnFn = spawn
): Promise<RunTaskResult> {
  const startMs = Date.now();
  const prompt = [task.title, task.description].filter(Boolean).join("\n\n");

  const spawnArgs = ["-p", prompt, "--output-format", "text"];
  if (task.assigned_skill) {
    spawnArgs.push("--allowedTools", `mcp__skills__${task.assigned_skill}`);
  }
  if (task.model) {
    spawnArgs.push("--model", task.model);
  }

  const opts = {
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    env: { ...process.env, MINDER_DISPATCHED: "1" },
  };

  // On Windows, `claude` is a .cmd file; must invoke via cmd.exe
  const [cmd, extraArgs]: [string, string[]] = isWindows
    ? ["cmd.exe", ["/c", "claude", ...spawnArgs]]
    : ["claude", spawnArgs];

  return new Promise<RunTaskResult>((resolve) => {
    const child = spawnFn(cmd, extraArgs, opts);
    const pid = child.pid;

    if (pid) writePidFile(pid);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", async (code) => {
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;

      if (code === 0) {
        const trimmed = stdout.trim();
        await completeTask(task.id, {
          output_summary: trimmed.slice(0, 4000) || undefined,
          duration_ms: durationMs,
        });
        resolve({ taskId: task.id, status: "done", output: trimmed, durationMs });
      } else {
        const errMsg = stderr.trim() || `claude exited with code ${code}`;
        await failTask(task.id, { error_message: errMsg.slice(0, 2000), duration_ms: durationMs });
        resolve({ taskId: task.id, status: "failed", error: errMsg, durationMs });
      }
    });

    child.on("error", async (err) => {
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;
      await failTask(task.id, { error_message: err.message.slice(0, 2000), duration_ms: durationMs });
      resolve({ taskId: task.id, status: "failed", error: err.message, durationMs });
    });
  });
}
