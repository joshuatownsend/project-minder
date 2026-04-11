import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachWorktreeOverlays } from "@/lib/scanner/worktrees";
import { ProjectData } from "@/lib/types";

// Mock all scanner dependencies
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/scanner/todoMd", () => ({
  scanTodoMd: vi.fn(),
}));

vi.mock("@/lib/scanner/manualStepsMd", () => ({
  scanManualStepsMd: vi.fn(),
}));

vi.mock("@/lib/scanner/insightsMd", () => ({
  scanInsightsMd: vi.fn(),
}));

import { promises as fs } from "fs";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { scanInsightsMd } from "@/lib/scanner/insightsMd";

const mockReadFile = vi.mocked(fs.readFile);
const mockScanTodo = vi.mocked(scanTodoMd);
const mockScanManualSteps = vi.mocked(scanManualStepsMd);
const mockScanInsights = vi.mocked(scanInsightsMd);

beforeEach(() => vi.clearAllMocks());

function makeProject(name: string, dirPath: string): ProjectData {
  return {
    slug: name.toLowerCase(),
    name,
    path: dirPath,
    status: "active",
    dependencies: [],
    dockerPorts: [],
    externalServices: [],
    scannedAt: new Date().toISOString(),
  };
}

describe("attachWorktreeOverlays", () => {
  it("does nothing when no worktree directories exist", async () => {
    const projects = [makeProject("my-app", "C:\\dev\\my-app")];
    const dirs = ["my-app", "other-project"];

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees).toBeUndefined();
  });

  it("attaches overlay when worktree has TODO.md", async () => {
    const projects = [makeProject("my-app", "C:\\dev\\my-app")];
    const dirs = ["my-app", "my-app--claude-worktrees-feature-login"];

    // Mock: .git file read fails (use fallback branch)
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    // Mock: worktree has TODOs
    mockScanTodo.mockImplementation(async (p: string) => {
      if (p.includes("worktrees")) {
        return { total: 2, completed: 0, pending: 2, items: [
          { text: "Task 1", completed: false },
          { text: "Task 2", completed: false },
        ]};
      }
      return undefined;
    });
    mockScanManualSteps.mockResolvedValue(undefined);
    mockScanInsights.mockResolvedValue(undefined);

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");

    expect(projects[0].worktrees).toHaveLength(1);
    expect(projects[0].worktrees![0].branch).toBe("feature/login");
    expect(projects[0].worktrees![0].todos?.total).toBe(2);
    expect(projects[0].worktrees![0].manualSteps).toBeUndefined();
  });

  it("skips worktree when no files have data", async () => {
    const projects = [makeProject("my-app", "C:\\dev\\my-app")];
    const dirs = ["my-app", "my-app--claude-worktrees-feature-empty"];

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockScanTodo.mockResolvedValue(undefined);
    mockScanManualSteps.mockResolvedValue(undefined);
    mockScanInsights.mockResolvedValue(undefined);

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees).toBeUndefined();
  });

  it("skips worktree with no matching parent project", async () => {
    const projects = [makeProject("other", "C:\\dev\\other")];
    const dirs = ["other", "my-app--claude-worktrees-feature-x"];

    // Should not even call scanners since no parent match
    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees).toBeUndefined();
    expect(mockScanTodo).not.toHaveBeenCalled();
  });

  it("matches parent project case-insensitively", async () => {
    const projects = [makeProject("My-App", "C:\\dev\\My-App")];
    const dirs = ["My-App", "my-app--claude-worktrees-fix-bug"];

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockScanTodo.mockResolvedValue({
      total: 1, completed: 0, pending: 1,
      items: [{ text: "Fix it", completed: false }],
    });
    mockScanManualSteps.mockResolvedValue(undefined);
    mockScanInsights.mockResolvedValue(undefined);

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees).toHaveLength(1);
    expect(projects[0].worktrees![0].branch).toBe("fix/bug");
  });

  it("reads actual branch name from .git file", async () => {
    const projects = [makeProject("my-app", "C:\\dev\\my-app")];
    const dirs = ["my-app", "my-app--claude-worktrees-feature-auth"];

    // Mock .git file → gitdir → HEAD
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      const p = filePath as string;
      if (p.endsWith(".git")) {
        return "gitdir: C:/dev/my-app/.git/worktrees/feature-auth";
      }
      if (p.endsWith("HEAD")) {
        return "ref: refs/heads/feature/authentication\n";
      }
      throw new Error("ENOENT");
    });

    mockScanTodo.mockResolvedValue({
      total: 1, completed: 0, pending: 1,
      items: [{ text: "Do it", completed: false }],
    });
    mockScanManualSteps.mockResolvedValue(undefined);
    mockScanInsights.mockResolvedValue(undefined);

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees![0].branch).toBe("feature/authentication");
  });

  it("handles multiple worktrees for same project", async () => {
    const projects = [makeProject("my-app", "C:\\dev\\my-app")];
    const dirs = [
      "my-app",
      "my-app--claude-worktrees-feature-a",
      "my-app--claude-worktrees-feature-b",
    ];

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockScanTodo.mockResolvedValue({
      total: 1, completed: 0, pending: 1,
      items: [{ text: "Item", completed: false }],
    });
    mockScanManualSteps.mockResolvedValue(undefined);
    mockScanInsights.mockResolvedValue(undefined);

    await attachWorktreeOverlays(projects, dirs, "C:\\dev");
    expect(projects[0].worktrees).toHaveLength(2);
  });
});
