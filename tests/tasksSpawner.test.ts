import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// Mock server-only and filesystem before importing spawner
vi.mock("server-only", () => ({}));
vi.mock("fs", () => {
  const files = new Map<string, string>();
  return {
    default: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((p: string, v: string) => files.set(p, v)),
      unlinkSync: vi.fn((p: string) => files.delete(p)),
      readdirSync: vi.fn((): string[] => [...files.keys()].map((k) => k.split("/").pop()!)),
    },
  };
});
vi.mock("../src/lib/platform", () => ({ isWindows: false }));
vi.mock("../src/lib/tasks/store", () => ({
  completeTask: vi.fn().mockResolvedValue(null),
  failTask: vi.fn().mockResolvedValue(null),
}));

import { runClassicTask, sweepStalePids } from "../src/lib/tasks/spawner";
import { completeTask, failTask } from "../src/lib/tasks/store";
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

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
