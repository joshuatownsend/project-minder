import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, PassThrough } from "stream";

// Mock server-side modules before importing spawner
vi.mock("@/lib/tasks/store", () => ({
  completeTask: vi.fn(),
  failTask: vi.fn(),
  setSessionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

function makeChild(): {
  child: ReturnType<typeof buildFakeChild>;
  close: (code: number) => void;
} {
  const child = buildFakeChild();
  const close = (code: number) => child.emit("close", code);
  return { child, close };
}

function buildFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
  };
  child.pid = 99999;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  return child;
}

import { getStreamChild, listStreamChildren } from "@/lib/tasks/spawner";
import { completeTask, failTask } from "@/lib/tasks/store";
import type { Task } from "@/lib/tasks/types";

const BASE_TASK: Task = {
  id: 1,
  title: "Test task",
  description: "do something",
  status: "running",
  priority: 3,
  quadrant: "do",
  execution_mode: "stream",
  risk_level: "low",
  requires_approval: 0,
  dry_run: 0,
  assigned_skill: null,
  model: null,
  scheduled_for: null,
  schedule_id: null,
  session_id: null,
  started_at: null,
  approved_at: null,
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
};

const mockCompleteTask = vi.mocked(completeTask);
const mockFailTask = vi.mocked(failTask);

beforeEach(() => {
  vi.clearAllMocks();
  // completeTask must return a Task object so onComplete can fire
  mockCompleteTask.mockResolvedValue(BASE_TASK);
  mockFailTask.mockResolvedValue({ ...BASE_TASK, status: "failed" });
});

describe("spawner child handle map", () => {
  it("getStreamChild returns null for unknown task id", () => {
    expect(getStreamChild(99999)).toBeNull();
  });

  it("listStreamChildren returns a Map", () => {
    expect(listStreamChildren()).toBeInstanceOf(Map);
  });

  it("child is registered in map during stream task execution and removed on close", async () => {
    const { child, close } = makeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import("child_process").spawn;

    const { runStreamTask } = await import("@/lib/tasks/spawner");
    const runPromise = runStreamTask(BASE_TASK, spawnFn);

    // Child should be in the map while running
    expect(getStreamChild(BASE_TASK.id)).toBe(child);

    // Emit close — child should be removed
    close(0);
    await runPromise;

    expect(getStreamChild(BASE_TASK.id)).toBeNull();
  });

  it("onDecision callback fires for DECISION: lines in stdout", async () => {
    const { child, close } = makeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import("child_process").spawn;

    const onDecision = vi.fn().mockResolvedValue(undefined);
    const { runStreamTask } = await import("@/lib/tasks/spawner");
    const runPromise = runStreamTask(BASE_TASK, spawnFn, onDecision);

    // Emit a DECISION: line followed by a newline
    child.stdout.push("DECISION: Should I overwrite? [yes, no]\n");
    close(0);
    await runPromise;

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision.mock.calls[0][0]).toBe(BASE_TASK.id);
    expect(onDecision.mock.calls[0][1]).toMatchObject({
      kind: "decision",
      prompt: "Should I overwrite?",
      choices: ["yes", "no"],
    });
  });

  it("INBOX: line triggers onDecision with kind=inbox", async () => {
    const { child, close } = makeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import("child_process").spawn;
    const onDecision = vi.fn().mockResolvedValue(undefined);

    const { runStreamTask } = await import("@/lib/tasks/spawner");
    const runPromise = runStreamTask(BASE_TASK, spawnFn, onDecision);

    child.stdout.push("INBOX: Still working on the migration\n");
    close(0);
    await runPromise;

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision.mock.calls[0][1]).toMatchObject({ kind: "inbox" });
  });

  it("onComplete callback fires after close", async () => {
    const { child, close } = makeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import("child_process").spawn;
    const onComplete = vi.fn().mockResolvedValue(undefined);

    const { runStreamTask } = await import("@/lib/tasks/spawner");
    const runPromise = runStreamTask(BASE_TASK, spawnFn, undefined, onComplete);

    close(0);
    await runPromise;

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0]).toMatchObject({ id: BASE_TASK.id });
  });
});
