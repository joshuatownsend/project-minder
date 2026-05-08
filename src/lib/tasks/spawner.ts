import "server-only";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import type { Task } from "./types";
import { completeTask, failTask, setSessionId } from "./store";
import { isWindows } from "../platform";

const PID_DIR = path.join(os.homedir(), ".minder", "pids");

try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch { /* non-fatal */ }

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

function buildPrompt(task: Task): string {
  return [task.title, task.description].filter(Boolean).join("\n\n");
}

function appendTaskFlags(args: string[], task: Task): void {
  if (task.assigned_skill) args.push("--allowedTools", `mcp__skills__${task.assigned_skill}`);
  if (task.model) args.push("--model", task.model);
}

// On Windows, `claude` is a .cmd file; must invoke via cmd.exe
function buildSpawnTarget(args: string[]): [string, string[]] {
  return isWindows ? ["cmd.exe", ["/c", "claude", ...args]] : ["claude", args];
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
  const spawnArgs = ["-p", buildPrompt(task), "--output-format", "text"];
  appendTaskFlags(spawnArgs, task);
  const [cmd, extraArgs] = buildSpawnTarget(spawnArgs);

  return new Promise<RunTaskResult>((resolve) => {
    const child = spawnFn(cmd, extraArgs, {
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      env: { ...process.env, MINDER_DISPATCHED: "1" },
    });
    const pid = child.pid;
    if (pid) writePidFile(pid);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const STDOUT_CAP = 50_000;
    const STDERR_CAP = 10_000;

    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < STDOUT_CAP) stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < STDERR_CAP) stderr += chunk.toString(); });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;

      if (code === 0) {
        const trimmed = stdout.trim();
        try {
          await completeTask(task.id, {
            output_summary: trimmed.slice(0, 4000) || undefined,
            duration_ms: durationMs,
          });
        } catch (err) {
          console.error(`[spawner] completeTask failed for task ${task.id}:`, err);
        }
        resolve({ taskId: task.id, status: "done", output: trimmed, durationMs });
      } else {
        const errMsg = stderr.trim() || `claude exited with code ${code}`;
        try {
          await failTask(task.id, { error_message: errMsg.slice(0, 2000), duration_ms: durationMs });
        } catch (err) {
          console.error(`[spawner] failTask failed for task ${task.id}:`, err);
        }
        resolve({ taskId: task.id, status: "failed", error: errMsg, durationMs });
      }
    });

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;
      try {
        await failTask(task.id, { error_message: err.message.slice(0, 2000), duration_ms: durationMs });
      } catch (storeErr) {
        console.error(`[spawner] failTask failed for task ${task.id}:`, storeErr);
      }
      resolve({ taskId: task.id, status: "failed", error: err.message, durationMs });
    });
  });
}

/**
 * Spawn `claude -p "<prompt>" --output-format stream-json --verbose` (stream mode).
 * Parses NDJSON events from stdout:
 *   - {type:"system", subtype:"init"} → write session_id early via setSessionId()
 *   - {type:"result"} → extract result text + total_cost_usd for completeTask()
 * Writes a PID marker file while the child is alive.
 */
export async function runStreamTask(
  task: Task,
  spawnFn: SpawnFn = spawn
): Promise<RunTaskResult> {
  const startMs = Date.now();
  const spawnArgs = ["-p", buildPrompt(task), "--output-format", "stream-json", "--verbose"];
  appendTaskFlags(spawnArgs, task);
  const [cmd, extraArgs] = buildSpawnTarget(spawnArgs);

  return new Promise<RunTaskResult>((resolve) => {
    const child = spawnFn(cmd, extraArgs, {
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      env: { ...process.env, MINDER_DISPATCHED: "1" },
    });
    const pid = child.pid;
    if (pid) writePidFile(pid);

    let lineBuffer = "";
    let resultText = "";
    let resultCostUsd: number | undefined;
    let stderr = "";
    let settled = false;
    let sessionIdWritten = false;
    let lineBufOverflow = false;
    const STDERR_CAP = 10_000;
    const LINEBUF_CAP = 5_000_000; // 5 MB — fail hard on runaway output

    // UTF-8 encoding prevents chunk boundaries from splitting multi-byte sequences.
    (child.stdout as NodeJS.ReadableStream & { setEncoding?: (enc: string) => void })
      ?.setEncoding?.("utf8");

    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (lineBufOverflow) return;
      lineBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (lineBuffer.length > LINEBUF_CAP) {
        lineBufOverflow = true;
        lineBuffer = "";
        return;
      }
      let nl: number;
      while ((nl = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, nl).trimEnd();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (!sessionIdWritten && evt.type === "system" && evt.subtype === "init" && typeof evt.session_id === "string") {
            sessionIdWritten = true;
            setSessionId(task.id, evt.session_id).catch((e) =>
              console.error(`[spawner] setSessionId failed for task ${task.id}:`, e)
            );
          } else if (evt.type === "result") {
            if (typeof evt.result === "string") resultText = evt.result;
            if (typeof evt.total_cost_usd === "number") resultCostUsd = evt.total_cost_usd;
          }
        } catch {
          // Non-JSON lines (hook output, warnings) — ignore
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString();
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;

      // Flush any trailing NDJSON line that wasn't newline-terminated on process exit
      if (lineBuffer.trim()) {
        try {
          const evt = JSON.parse(lineBuffer.trim()) as Record<string, unknown>;
          if (!sessionIdWritten && evt.type === "system" && evt.subtype === "init" && typeof evt.session_id === "string") {
            sessionIdWritten = true;
            // Await here — completeTask below will change status to 'done', blocking the setSessionId guard
            await setSessionId(task.id, evt.session_id).catch((e) =>
              console.error(`[spawner] setSessionId failed for task ${task.id}:`, e)
            );
          } else if (evt.type === "result") {
            if (typeof evt.result === "string") resultText = evt.result;
            if (typeof evt.total_cost_usd === "number") resultCostUsd = evt.total_cost_usd;
          }
        } catch {
          // Not valid JSON — ignore
        }
      }

      if (lineBufOverflow) {
        const errMsg = "Stream output exceeded 5 MB buffer limit";
        try {
          await failTask(task.id, { error_message: errMsg, duration_ms: durationMs });
        } catch (err) {
          console.error(`[spawner] failTask failed for task ${task.id}:`, err);
        }
        resolve({ taskId: task.id, status: "failed", error: errMsg, durationMs });
        return;
      }

      if (code === 0) {
        const trimmed = resultText.trim();
        try {
          await completeTask(task.id, {
            output_summary: trimmed.slice(0, 4000) || undefined,
            duration_ms: durationMs,
            cost_usd: resultCostUsd,
          });
        } catch (err) {
          console.error(`[spawner] completeTask failed for task ${task.id}:`, err);
        }
        resolve({ taskId: task.id, status: "done", output: trimmed, durationMs });
      } else {
        const errMsg = stderr.trim() || `claude exited with code ${code}`;
        try {
          await failTask(task.id, { error_message: errMsg.slice(0, 2000), duration_ms: durationMs });
        } catch (err) {
          console.error(`[spawner] failTask failed for task ${task.id}:`, err);
        }
        resolve({ taskId: task.id, status: "failed", error: errMsg, durationMs });
      }
    });

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      if (pid) deletePidFile(pid);
      const durationMs = Date.now() - startMs;
      try {
        await failTask(task.id, { error_message: err.message.slice(0, 2000), duration_ms: durationMs });
      } catch (storeErr) {
        console.error(`[spawner] failTask failed for task ${task.id}:`, storeErr);
      }
      resolve({ taskId: task.id, status: "failed", error: err.message, durationMs });
    });
  });
}
