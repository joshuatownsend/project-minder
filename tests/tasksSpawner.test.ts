import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// Mock server-only and filesystem before importing spawner
vi.mock("server-only", () => ({}));
// Directories that taskCwd() should treat as existing. Tests push paths here to
// exercise the "metadata.projectPath is a real dir" branch; everything else is
// reported missing so the stale-path fallback is covered too.
const existingDirs = new Set<string>();
vi.mock("fs", () => {
  const files = new Map<string, string>();
  return {
    default: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((p: string, v: string) => files.set(p, v)),
      unlinkSync: vi.fn((p: string) => files.delete(p)),
      readdirSync: vi.fn((): string[] => [...files.keys()].map((k) => k.split("/").pop()!)),
      existsSync: vi.fn((p: string): boolean => existingDirs.has(p)),
      statSync: vi.fn((p: string) => ({ isDirectory: () => existingDirs.has(p) })),
    },
  };
});
vi.mock("../src/lib/platform", () => ({ isWindows: false }));
vi.mock("../src/lib/tasks/store", () => ({
  completeTask: vi.fn().mockResolvedValue(null),
  failTask: vi.fn().mockResolvedValue(null),
  setSessionId: vi.fn().mockResolvedValue(undefined),
}));

import { runClassicTask, runStreamTask, sweepStalePids, taskCwd } from "../src/lib/tasks/spawner";
import { completeTask, failTask, setSessionId } from "../src/lib/tasks/store";
import type { Task } from "../src/lib/tasks/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Test task",
    description: "do something",
    status: "running",
    priority: 3,
    quadrant: "do",
    assigned_skill: null,
    model: null,
    execution_mode: "classic",
    scheduled_for: null,
    requires_approval: 0,
    risk_level: "low",
    dry_run: 0,
    schedule_id: null,
    approved_at: null,
    session_id: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    cost_usd: null,
    output_summary: null,
    error_message: null,
    consecutive_failures: 0,
    created_at: new Date().toISOString(),
    metadata: null,
    swarm_id: null,
    swarm_role: null,
    ...overrides,
  };
}

function makeChildProcess(pid = 1234): {
  proc: Partial<ChildProcess>;
  emitOutput: (data: string) => void;
  emitError: (err: Error) => void;
  emitClose: (code: number) => void;
} {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const procEmitter = new EventEmitter();
  const proc: Partial<ChildProcess> = {
    pid,
    stdout: stdoutEmitter as unknown as NodeJS.ReadableStream,
    stderr: stderrEmitter as unknown as NodeJS.ReadableStream,
    on: procEmitter.on.bind(procEmitter) as ChildProcess["on"],
  } as Partial<ChildProcess>;

  return {
    proc,
    emitOutput: (data) => stdoutEmitter.emit("data", Buffer.from(data)),
    emitError: (err) => procEmitter.emit("error", err),
    emitClose: (code) => procEmitter.emit("close", code),
  };
}

describe("runClassicTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls completeTask on exit code 0", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 42 });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitOutput("Task complete: all done");
    emitClose(0);

    const result = await promise;
    expect(result.status).toBe("done");
    expect(result.taskId).toBe(42);
    expect(completeTask).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ output_summary: "Task complete: all done" })
    );
  });

  it("calls failTask on non-zero exit code", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 7 });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(1);

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(failTask).toHaveBeenCalledWith(7, expect.objectContaining({ error_message: expect.any(String) }));
  });

  it("calls failTask on spawn error", async () => {
    const { proc, emitError } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 99 });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitError(new Error("ENOENT: claude not found"));

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(failTask).toHaveBeenCalledWith(99, expect.objectContaining({ error_message: "ENOENT: claude not found" }));
  });

  it("passes model to spawn args when set", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ model: "claude-haiku-4-5" });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    const [, args] = spawnFn.mock.calls[0] as [string, string[]];
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4-5");
  });
});

describe("sweepStalePids", () => {
  it("runs without throwing", () => {
    expect(() => sweepStalePids()).not.toThrow();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runStreamTask
// ---------------------------------------------------------------------------

describe("runStreamTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function emitLines(emitOutput: (d: string) => void, lines: unknown[]) {
    emitOutput(lines.map((l) => JSON.stringify(l) + "\n").join(""));
  }

  it("extracts session_id from init event and calls setSessionId", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 10, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitLines(emitOutput, [
      { type: "system", subtype: "init", session_id: "abc-123" },
      { type: "result", result: "Done", total_cost_usd: 0.001 },
    ]);
    emitClose(0);

    await promise;
    expect(setSessionId).toHaveBeenCalledWith(10, "abc-123");
  });

  it("calls completeTask with result text and cost_usd on exit 0", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 11, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitLines(emitOutput, [
      { type: "system", subtype: "init", session_id: "sess-11" },
      { type: "result", result: "All done", total_cost_usd: 0.005 },
    ]);
    emitClose(0);

    const result = await promise;
    expect(result.status).toBe("done");
    expect(result.taskId).toBe(11);
    expect(completeTask).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ output_summary: "All done", cost_usd: 0.005 })
    );
  });

  it("handles chunk-boundary split lines correctly", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 12, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);

    // Split the result JSON line across two chunks
    const line = JSON.stringify({ type: "result", result: "Split result", total_cost_usd: 0.002 });
    emitOutput(line.slice(0, 20));
    emitOutput(line.slice(20) + "\n");
    emitClose(0);

    const result = await promise;
    expect(result.status).toBe("done");
    expect(completeTask).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ output_summary: "Split result", cost_usd: 0.002 })
    );
  });

  it("tolerates non-JSON lines without throwing", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 13, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitOutput("not json\n");
    emitOutput(JSON.stringify({ type: "result", result: "Fine", total_cost_usd: 0 }) + "\n");
    emitClose(0);

    const result = await promise;
    expect(result.status).toBe("done");
  });

  it("calls failTask on non-zero exit code", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 14, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(1);

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(failTask).toHaveBeenCalledWith(14, expect.objectContaining({ error_message: expect.any(String) }));
  });

  it("calls failTask on spawn error", async () => {
    const { proc, emitError } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 15, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitError(new Error("ENOENT: claude not found"));

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(failTask).toHaveBeenCalledWith(15, expect.objectContaining({ error_message: "ENOENT: claude not found" }));
  });

  it("passes model to spawn args when set", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ execution_mode: "stream", model: "claude-haiku-4-5" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    const [, args] = spawnFn.mock.calls[0] as [string, string[]];
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4-5");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });

  it("flushes trailing result line without newline on close", async () => {
    const { proc, emitOutput, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 16, execution_mode: "stream" });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    // No trailing \n — simulates process flushing stdout on exit without newline
    emitOutput(JSON.stringify({ type: "result", result: "No newline", total_cost_usd: 0.003 }));
    emitClose(0);

    const result = await promise;
    expect(result.status).toBe("done");
    expect(completeTask).toHaveBeenCalledWith(
      16,
      expect.objectContaining({ output_summary: "No newline", cost_usd: 0.003 })
    );
  });
});

// ---------------------------------------------------------------------------
// task working directory (cwd) — board-promoted / delegated tasks (PR #227)
// ---------------------------------------------------------------------------

describe("task working directory (cwd)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existingDirs.clear();
  });

  function spawnOpts(spawnFn: ReturnType<typeof vi.fn>) {
    return spawnFn.mock.calls[0][2] as { cwd?: string };
  }

  it("taskCwd returns metadata.projectPath when it exists as a directory", () => {
    existingDirs.add("C:\\dev\\some-proj");
    const task = makeTask({ metadata: JSON.stringify({ projectPath: "C:\\dev\\some-proj" }) });
    expect(taskCwd(task)).toBe("C:\\dev\\some-proj");
  });

  it("taskCwd falls back to metadata.worktreePath when projectPath absent", () => {
    existingDirs.add("C:\\dev\\wt");
    const task = makeTask({ metadata: JSON.stringify({ worktreePath: "C:\\dev\\wt" }) });
    expect(taskCwd(task)).toBe("C:\\dev\\wt");
  });

  it("taskCwd returns undefined for a stale/missing path (no crash)", () => {
    const task = makeTask({ metadata: JSON.stringify({ projectPath: "C:\\dev\\gone" }) });
    expect(taskCwd(task)).toBeUndefined();
  });

  it("taskCwd returns undefined for malformed metadata", () => {
    const task = makeTask({ metadata: "{not json" });
    expect(taskCwd(task)).toBeUndefined();
  });

  it("runClassicTask spawns with cwd === metadata.projectPath when present", async () => {
    existingDirs.add("C:\\dev\\promoted");
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 20, metadata: JSON.stringify({ projectPath: "C:\\dev\\promoted" }) });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    expect(spawnOpts(spawnFn).cwd).toBe("C:\\dev\\promoted");
  });

  it("runClassicTask spawns with no cwd when metadata has no projectPath", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 21 }); // metadata: null
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    expect(spawnOpts(spawnFn).cwd).toBeUndefined();
  });

  it("runStreamTask spawns with cwd === metadata.projectPath when present", async () => {
    existingDirs.add("C:\\dev\\promoted-stream");
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({
      id: 22,
      execution_mode: "stream",
      metadata: JSON.stringify({ projectPath: "C:\\dev\\promoted-stream" }),
    });
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    expect(spawnOpts(spawnFn).cwd).toBe("C:\\dev\\promoted-stream");
  });

  it("runStreamTask spawns with no cwd when metadata has no projectPath", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const task = makeTask({ id: 23, execution_mode: "stream" }); // metadata: null
    const promise = runStreamTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    expect(spawnOpts(spawnFn).cwd).toBeUndefined();
  });

  it("spawns with no cwd when the project path is stale (defensive fallback)", async () => {
    const { proc, emitClose } = makeChildProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    // projectPath set but never added to existingDirs ⇒ treated as missing.
    const task = makeTask({ id: 24, metadata: JSON.stringify({ projectPath: "C:\\dev\\gone" }) });
    const promise = runClassicTask(task, spawnFn as unknown as typeof import("child_process").spawn);
    emitClose(0);
    await promise;

    expect(spawnOpts(spawnFn).cwd).toBeUndefined();
  });
});
