import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "@/lib/tasks/types";

vi.mock("@/lib/tasks/store", () => ({
  createTask: vi.fn().mockResolvedValue({ id: 42 }),
}));

vi.mock("@/lib/todoWriter", () => ({
  toggleTodoInFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn().mockResolvedValue({ devRoots: [] }),
  getDevRoots: vi.fn(() => ["/mock/roots"]),
  mutateConfig: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs so resolveProjectPath can find the project
vi.mock("fs", () => {
  const statFn = vi.fn().mockResolvedValue({ isDirectory: () => true });
  return {
    default: { promises: { stat: statFn } },
    promises: { stat: statFn },
  };
});

import { createTask } from "@/lib/tasks/store";
import { toggleTodoInFile } from "@/lib/todoWriter";
import { delegateTodo, onTaskCompleteToggleTodo } from "@/lib/tasks/todoDelegation";

const mockCreateTask = vi.mocked(createTask);
const mockToggleTodo = vi.mocked(toggleTodoInFile);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    title: "Write a unit test",
    description: "Write a unit test",
    status: "done",
    priority: 3,
    quadrant: "delegated-todo",
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
    metadata: JSON.stringify({
      sourceFile: "TODO.md",
      lineNumber: 5,
      projectSlug: "my-project",
      projectPath: "/mock/roots/my-project",
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({ id: 42 } as Task);
});

describe("delegateTodo", () => {
  it("creates a task with delegated-todo quadrant and correct metadata", async () => {
    const result = await delegateTodo({
      projectSlug: "my-project",
      lineNumber: 5,
      todoText: "Write a unit test for foo",
      devRoots: ["/mock/roots"],
    });

    expect(result.taskId).toBe(42);
    expect(mockCreateTask).toHaveBeenCalledOnce();

    const call = mockCreateTask.mock.calls[0][0];
    expect(call.quadrant).toBe("delegated-todo");
    expect(call.title).toBe("Write a unit test for foo");
    expect(call.metadata).toMatchObject({
      sourceFile: "TODO.md",
      lineNumber: 5,
      projectSlug: "my-project",
    });
  });

  it("truncates long todo text to 120 chars for title", async () => {
    const longText = "x".repeat(200);
    await delegateTodo({
      projectSlug: "my-project",
      lineNumber: 1,
      todoText: longText,
      devRoots: ["/mock/roots"],
    });
    const call = mockCreateTask.mock.calls[0][0];
    expect(call.title!.length).toBeLessThanOrEqual(120);
    expect(call.description).toBe(longText);
  });

  it("throws when project is not found in devRoots", async () => {
    const { promises: fsMock } = await import("fs");
    vi.mocked(fsMock.stat).mockRejectedValueOnce(new Error("ENOENT"));

    await expect(
      delegateTodo({
        projectSlug: "missing-project",
        lineNumber: 1,
        todoText: "Do something",
        devRoots: ["/nonexistent"],
      })
    ).rejects.toThrow(/not found/);
  });
});

describe("onTaskCompleteToggleTodo", () => {
  it("toggles the TODO checkbox when task status is done", async () => {
    const task = makeTask({ status: "done" });
    await onTaskCompleteToggleTodo(task);
    expect(mockToggleTodo).toHaveBeenCalledWith("/mock/roots/my-project", 5);
  });

  it("skips toggle when task status is failed", async () => {
    const task = makeTask({ status: "failed" });
    await onTaskCompleteToggleTodo(task);
    expect(mockToggleTodo).not.toHaveBeenCalled();
  });

  it("skips toggle when task has no metadata", async () => {
    const task = makeTask({ metadata: null });
    await onTaskCompleteToggleTodo(task);
    expect(mockToggleTodo).not.toHaveBeenCalled();
  });

  it("skips toggle when metadata is malformed JSON", async () => {
    const task = makeTask({ metadata: "not-json{{{" });
    await onTaskCompleteToggleTodo(task);
    expect(mockToggleTodo).not.toHaveBeenCalled();
  });

  it("skips toggle when sourceFile is not TODO.md", async () => {
    const task = makeTask({
      metadata: JSON.stringify({
        sourceFile: "MANUAL_STEPS.md",
        lineNumber: 3,
        projectPath: "/some/path",
        projectSlug: "proj",
      }),
    });
    await onTaskCompleteToggleTodo(task);
    expect(mockToggleTodo).not.toHaveBeenCalled();
  });

  it("does not throw when toggleTodoInFile fails (best-effort)", async () => {
    const task = makeTask({ status: "done" });
    mockToggleTodo.mockRejectedValueOnce(new Error("file locked"));
    await expect(onTaskCompleteToggleTodo(task)).resolves.toBeUndefined();
  });
});
