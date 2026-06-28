import "server-only";
import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import fs from "fs";
import type { Task } from "./types";
import { completeTask, failTask, setSessionId, getTask } from "./store";
import { isWindows } from "../platform";
import { createDecisionParser, type DecisionEvent } from "./decisionParser";

const PID_DIR = path.join(os.homedir(), ".minder", "pids");

try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch { /* non-fatal */ }

/** Live stream-mode children, keyed by task id. Used by HITL /decide and emergency stop. */
const streamChildren = new Map<number, ChildProcess>();

/** Return the stream child for a task, or null if it has already exited. */
export function getStreamChild(taskId: number): ChildProcess | null {
  return streamChildren.get(taskId) ?? null;
}

/** List all live stream child handles. Used by emergency stop to kill confirmed children. */
export function listStreamChildren(): Map<number, ChildProcess> {
  return streamChildren;
}

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

/** Callback injected by the dispatcher for HITL decision events. */
export type OnDecisionFn = (taskId: number, event: DecisionEvent) => Promise<void>;

/** Callback injected by the dispatcher to react when a task completes or fails. */
export type OnCompleteFn = (task: Task) => Promise<void>;


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
 * Derive the working directory a task should run in, from its metadata.
 * Board-promoted (`promoteBoardIssueToTask`) and delegated (`delegateTodo`)
 * tasks store `projectPath`; the worktree convention may instead carry
 * `worktreePath`. Returns the directory only if it exists and is a directory.
 *
 * Fully defensive: malformed metadata, a missing/stale path, or an fs error all
 * yield `undefined`, so the spawn falls back to the server's cwd (current
 * behavior) rather than crashing. Cron/manual tasks with no path are unchanged.
 *
 * Note: worktree tasks dispatch through `runWorktreeTask`, which wraps `spawnFn`
 * to force the worktree cwd and thus overrides whatever this returns.
 */
export function taskCwd(task: Task): string | undefined {
  let meta: { projectPath?: string; worktreePath?: string };
  try {
    meta = JSON.parse(task.metadata ?? "{}") as typeof meta;
  } catch {
    return undefined; // malformed metadata — inherit current cwd
  }
  const candidate = meta.projectPath ?? meta.worktreePath;
  if (!candidate || typeof candidate !== "string") return undefined;
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // fs error (permissions, race) — treat as missing, never crash the spawn
  }
  return undefined;
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
      // Run in the task's project dir (board-promoted / delegated tasks); a
      // missing/absent path resolves to undefined ⇒ inherit current cwd.
      cwd: taskCwd(task),
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
 *   - DECISION: / INBOX: plain-text markers → forwarded to onDecision callback
 * Writes a PID marker file while the child is alive.
 * Stashes the ChildProcess in streamChildren map for HITL stdin injection and emergency stop.
 */
export async function runStreamTask(
  task: Task,
  spawnFn: SpawnFn = spawn,
  onDecision?: OnDecisionFn,
  onComplete?: OnCompleteFn
): Promise<RunTaskResult> {
  const startMs = Date.now();
  const spawnArgs = ["-p", buildPrompt(task), "--output-format", "stream-json", "--verbose"];
  appendTaskFlags(spawnArgs, task);
  const [cmd, extraArgs] = buildSpawnTarget(spawnArgs);

  return new Promise<RunTaskResult>((resolve) => {
    function fireOnComplete(t: Task | null) {
      if (t && onComplete) {
        onComplete(t).catch((e) =>
          console.error(`[spawner] onComplete failed for task ${task.id}:`, e)
        );
      }
    }

    // Returns elapsed ms, or null if the handler already ran (settled guard).
    function teardown(): number | null {
      if (settled) return null;
      settled = true;
      if (pid) deletePidFile(pid);
      streamChildren.delete(task.id);
      decisionParser?.finish();
      return Date.now() - startMs;
    }

    const child = spawnFn(cmd, extraArgs, {
      // stdin is "pipe" so HITL can write answers; classic mode keeps "ignore"
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      env: { ...process.env, MINDER_DISPATCHED: "1" },
      // Run in the task's project dir (board-promoted / delegated tasks); a
      // missing/absent path resolves to undefined ⇒ inherit current cwd.
      cwd: taskCwd(task),
    });
    const pid = child.pid;
    if (pid) writePidFile(pid);
    streamChildren.set(task.id, child);

    let lineBuffer = "";
    let resultText = "";
    let resultCostUsd: number | undefined;
    let stderr = "";
    let settled = false;
    let sessionIdWritten = false;
    let lineBufOverflow = false;
    const STDERR_CAP = 10_000;
    const LINEBUF_CAP = 5_000_000; // 5 MB — fail hard on runaway output

    const decisionParser = onDecision ? createDecisionParser() : null;

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
          // Non-JSON line — feed into decision parser for DECISION:/INBOX: markers
          if (decisionParser) {
            const events = decisionParser.feed(line);
            for (const event of events) {
              onDecision!(task.id, event).catch((e) =>
                console.error(`[spawner] onDecision failed for task ${task.id}:`, e)
              );
            }
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString();
    });

    child.on("close", async (code) => {
      const durationMs = teardown();
      if (durationMs === null) return;

      // Flush any trailing NDJSON line that wasn't newline-terminated on process exit
      if (lineBuffer.trim()) {
        try {
          const evt = JSON.parse(lineBuffer.trim()) as Record<string, unknown>;
          if (!sessionIdWritten && evt.type === "system" && evt.subtype === "init" && typeof evt.session_id === "string") {
            sessionIdWritten = true;
            // Must await: completeTask below changes status to 'done', blocking the setSessionId guard
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
        let completedTask = null;
        try {
          completedTask = await completeTask(task.id, {
            output_summary: trimmed.slice(0, 4000) || undefined,
            duration_ms: durationMs,
            cost_usd: resultCostUsd,
          });
        } catch (err) {
          console.error(`[spawner] completeTask failed for task ${task.id}:`, err);
        }
        fireOnComplete(completedTask);
        resolve({ taskId: task.id, status: "done", output: trimmed, durationMs });
      } else {
        const errMsg = stderr.trim() || `claude exited with code ${code}`;
        let failedTask = null;
        try {
          failedTask = await failTask(task.id, { error_message: errMsg.slice(0, 2000), duration_ms: durationMs });
        } catch (err) {
          console.error(`[spawner] failTask failed for task ${task.id}:`, err);
        }
        fireOnComplete(failedTask);
        resolve({ taskId: task.id, status: "failed", error: errMsg, durationMs });
      }
    });

    child.on("error", async (err) => {
      const durationMs = teardown();
      if (durationMs === null) return;
      let failedTask = null;
      try {
        failedTask = await failTask(task.id, { error_message: err.message.slice(0, 2000), duration_ms: durationMs });
      } catch (storeErr) {
        console.error(`[spawner] failTask failed for task ${task.id}:`, storeErr);
      }
      fireOnComplete(failedTask);
      resolve({ taskId: task.id, status: "failed", error: err.message, durationMs });
    });
  });
}

const execFileAsync = promisify(execFile);

/** Injects cwd via spawnFn closure — avoids signature changes to runClassicTask/runStreamTask. */
export async function runWorktreeTask(
  task: Task,
  spawnFn: SpawnFn = spawn,
  onDecision?: OnDecisionFn,
  onComplete?: OnCompleteFn
): Promise<RunTaskResult> {
  let meta: { worktreePath?: string; projectPath?: string } = {};
  try {
    meta = JSON.parse(task.metadata ?? "{}") as typeof meta;
  } catch {
    // malformed metadata — fall through to normal dispatch
  }

  const { worktreePath, projectPath } = meta;

  if (!projectPath) {
    // No project context at all — dispatch with default cwd and inherited spawnFn.
    if (task.execution_mode === "stream") return runStreamTask(task, spawnFn, onDecision, onComplete);
    const result = await runClassicTask(task, spawnFn);
    if (onComplete) {
      const updated = await getTask(task.id).catch(() => null);
      if (updated) onComplete(updated).catch((e) => console.error(`[spawner] onComplete failed for task ${task.id}:`, e));
    }
    return result;
  }

  // Shared mode: no worktree, but cwd should be the project root.
  if (!worktreePath) {
    const sharedSpawnFn = ((cmd: string, args: readonly string[], opts: object) =>
      spawnFn(cmd as string, args as readonly string[], { ...opts, cwd: projectPath } as never)) as unknown as SpawnFn;
    if (task.execution_mode === "stream") return runStreamTask(task, sharedSpawnFn, onDecision, onComplete);
    const result = await runClassicTask(task, sharedSpawnFn);
    if (onComplete) {
      const updated = await getTask(task.id).catch(() => null);
      if (updated) onComplete(updated).catch((e) => console.error(`[spawner] onComplete failed for task ${task.id}:`, e));
    }
    return result;
  }

  // Create the worktree if it doesn't already exist.
  if (!fs.existsSync(worktreePath)) {
    const branchName = `swarm-${task.swarm_id ?? "x"}-${task.id}-${Date.now()}`;
    try {
      await execFileAsync("git", ["worktree", "add", "-B", branchName, worktreePath, "HEAD"], {
        cwd: projectPath,
      });
    } catch (err) {
      const errMsg = `git worktree add failed: ${(err as Error).message}`.slice(0, 2000);
      console.error(`[spawner] ${errMsg}`);
      await failTask(task.id, { error_message: errMsg }).catch(() => {});
      return { taskId: task.id, status: "failed", error: errMsg, durationMs: 0 };
    }
  }

  // Wrap spawnFn so child processes inherit the target cwd.
  // Cast required because SpawnFn has many overloads; we only use the (cmd, args, opts) form.
  const effectiveCwd = worktreePath;
  const cwdSpawnFn = ((cmd: string, args: readonly string[], opts: object) =>
    spawnFn(cmd as string, args as readonly string[], { ...opts, cwd: effectiveCwd } as never)) as unknown as SpawnFn;

  if (task.execution_mode === "stream") {
    return runStreamTask(task, cwdSpawnFn, onDecision, onComplete);
  }
  const result = await runClassicTask(task, cwdSpawnFn);
  if (onComplete) {
    const updated = await getTask(task.id).catch(() => null);
    if (updated) onComplete(updated).catch((e) => console.error(`[spawner] onComplete failed for task ${task.id}:`, e));
  }
  return result;
}
