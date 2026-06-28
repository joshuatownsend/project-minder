import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "@/lib/tasks/types";

// Mock the task store so no real SQLite is touched (mirrors todoDelegation.test).
vi.mock("@/lib/tasks/store", () => ({
  createTask: vi.fn().mockResolvedValue({ id: 42 }),
}));

// Mock fs for the board read/write plumbing (mirrors boardWriter.test). The
// pure parser/transforms run against the returned content; canonicalProjectDir
// reads .minder.json (absent ⇒ config defaults), scanBoardMd + setIssueStatus
// read/atomic-write BOARD.md.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
}));

import { promises as fs } from "fs";
import { createTask } from "@/lib/tasks/store";
import { BoardWriteError } from "@/lib/boardWriter";
import {
  promoteBoardIssueToTask,
  onTaskCompleteSyncBoard,
  findIssueById,
} from "@/lib/tasks/boardDelegation";
import { parseBoardMd } from "@/lib/scanner/boardMd";

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockRename = vi.mocked(fs.rename);
const mockCreateTask = vi.mocked(createTask);

const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const BOARD = `# Board — myapp
<!-- minder-board: v1 -->

## Epic: Auth ^e-aaaa  [doing]  !high

- [ ] Wire provider ^i-1111  [todo]  #frontend
- [x] Spike ^i-3333  [done]

## Inbox
- [ ] (finding) leak ^i-5555  [triage]  @wt:fix-y  ~session:s9
`;

/** Fake an FS where BOARD.md returns `content` and everything else (e.g.
 *  .minder.json) is absent so config falls back to defaults. */
function fsWithBoard(content: string) {
  return async (p: unknown) => {
    if (String(p).endsWith("BOARD.md")) return content;
    throw ENOENT;
  };
}

const renameTargets = () => mockRename.mock.calls.map((c) => String(c[1]));
const writtenContent = () =>
  mockWriteFile.mock.calls.map((c) => String(c[1])).join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({ id: 42 } as Task);
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
});

describe("findIssueById", () => {
  const board = parseBoardMd(BOARD);
  it("finds an issue inside an epic", () => {
    expect(findIssueById(board, "i-1111")?.title).toBe("Wire provider");
  });
  it("finds an Inbox issue", () => {
    expect(findIssueById(board, "i-5555")?.worktree).toBe("fix-y");
  });
  it("returns undefined for an unknown id / undefined board", () => {
    expect(findIssueById(board, "i-9999")).toBeUndefined();
    expect(findIssueById(undefined, "i-1111")).toBeUndefined();
  });
});

describe("promoteBoardIssueToTask", () => {
  it("creates a board-sourced task and flips the issue to doing", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));

    const result = await promoteBoardIssueToTask({
      projectPath: "C:\\dev\\myapp",
      issueId: "i-1111",
    });

    expect(result.taskId).toBe(42);
    expect(mockCreateTask).toHaveBeenCalledOnce();

    const call = mockCreateTask.mock.calls[0][0];
    expect(call.quadrant).toBe("delegated-todo");
    expect(call.title).toBe("Wire provider");
    expect(call.metadata).toMatchObject({
      sourceType: "board-issue",
      boardIssueId: "i-1111",
      projectSlug: "myapp",
    });

    // The status flip wrote BOARD.md with the issue now in `doing`.
    expect(renameTargets().some((t) => t.endsWith("BOARD.md"))).toBe(true);
    expect(writtenContent()).toContain("- [>] Wire provider");
    expect(result.board && findIssueById(result.board, "i-1111")?.status).toBe(
      "doing",
    );
  });

  it("threads provenance (worktree + sessionId) into task metadata", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));

    await promoteBoardIssueToTask({
      projectPath: "C:\\dev\\myapp",
      issueId: "i-5555",
      sessionId: "sess-abc",
      priority: 2,
      assignedSkill: "feature-dev",
      riskLevel: "medium",
    });

    const call = mockCreateTask.mock.calls[0][0];
    expect(call.priority).toBe(2);
    expect(call.assigned_skill).toBe("feature-dev");
    expect(call.risk_level).toBe("medium");
    expect(call.metadata).toMatchObject({
      sourceType: "board-issue",
      boardIssueId: "i-5555",
      worktree: "fix-y",
      sessionId: "sess-abc",
    });
  });

  it("throws NOT_FOUND and creates no task for a missing issue", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));

    await expect(
      promoteBoardIssueToTask({
        projectPath: "C:\\dev\\myapp",
        issueId: "i-9999",
      }),
    ).rejects.toMatchObject({
      name: "BoardWriteError",
      code: "NOT_FOUND",
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("still returns the taskId when the status flip fails (best-effort)", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));
    // The only write is the setIssueStatus → doing flip; make it fail.
    mockWriteFile.mockRejectedValue(new Error("disk full"));

    const result = await promoteBoardIssueToTask({
      projectPath: "C:\\dev\\myapp",
      issueId: "i-1111",
    });

    expect(result.taskId).toBe(42);
    expect(mockCreateTask).toHaveBeenCalledOnce();
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    title: "Wire provider",
    description: "Wire provider",
    status: "done",
    priority: 3,
    quadrant: "delegated-todo",
    execution_mode: "classic",
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
      sourceType: "board-issue",
      boardIssueId: "i-1111",
      projectPath: "C:\\dev\\myapp",
      projectSlug: "myapp",
    }),
    swarm_id: null,
    swarm_role: null,
    ...overrides,
  };
}

describe("onTaskCompleteSyncBoard", () => {
  it("flips the board issue to done for a completed board-sourced task", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));

    await onTaskCompleteSyncBoard(makeTask({ status: "done" }));

    expect(renameTargets().some((t) => t.endsWith("BOARD.md"))).toBe(true);
    expect(writtenContent()).toContain("- [x] Wire provider");
  });

  it("does not touch the board when the task did not finish (status !== done)", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));
    await onTaskCompleteSyncBoard(makeTask({ status: "failed" }));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("ignores a TODO-sourced task (no board metadata)", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));
    await onTaskCompleteSyncBoard(
      makeTask({
        metadata: JSON.stringify({
          sourceFile: "TODO.md",
          lineNumber: 5,
          projectPath: "C:\\dev\\myapp",
          projectSlug: "myapp",
        }),
      }),
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("ignores a task with no metadata / malformed metadata", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));
    await onTaskCompleteSyncBoard(makeTask({ metadata: null }));
    await onTaskCompleteSyncBoard(makeTask({ metadata: "not-json{{{" }));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("does not throw when the board write fails (best-effort)", async () => {
    mockReadFile.mockImplementation(fsWithBoard(BOARD));
    mockWriteFile.mockRejectedValue(new Error("locked"));
    await expect(
      onTaskCompleteSyncBoard(makeTask({ status: "done" })),
    ).resolves.toBeUndefined();
  });
});
