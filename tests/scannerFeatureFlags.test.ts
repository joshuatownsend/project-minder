import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dirent, Stats } from "fs";
import type { MinderConfig } from "@/lib/types";

// Mock fs so the orchestrator finds exactly one fake project directory
// and treats it as a git repo. readdir returns the dirent list; stat is
// called by isGitRepo() against the project's `.git` path.
vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}));

// Mock config + featureFlags wiring at the source so we control what the
// orchestrator sees. getFlag() stays real — we want to test its wiring,
// not stub it out.
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
  getDevRoots: (config: MinderConfig) => [config.devRoot || "C:\\dev"],
}));

// Mock every scanner module — vi.fn() returns undefined by default, so each
// per-test case overrides only what it cares about.
vi.mock("@/lib/scanner/packageJson", () => ({
  scanPackageJson: vi.fn(),
}));
vi.mock("@/lib/scanner/envFile", () => ({
  scanEnvFiles: vi.fn(),
}));
vi.mock("@/lib/scanner/dockerCompose", () => ({
  scanDockerCompose: vi.fn(),
}));
vi.mock("@/lib/scanner/git", () => ({
  scanGit: vi.fn(),
}));
vi.mock("@/lib/scanner/claudeMd", () => ({
  scanClaudeMd: vi.fn(),
}));
vi.mock("@/lib/scanner/todoMd", () => ({
  scanTodoMd: vi.fn(),
}));
vi.mock("@/lib/scanner/claudeSessions", () => ({
  scanClaudeSessions: vi.fn(),
}));
vi.mock("@/lib/scanner/manualStepsMd", () => ({
  scanManualStepsMd: vi.fn(),
}));
vi.mock("@/lib/scanner/insightsMd", () => ({
  scanInsightsMd: vi.fn(),
}));
vi.mock("@/lib/scanner/claudeHooks", () => ({
  scanClaudeHooks: vi.fn(),
}));
vi.mock("@/lib/scanner/mcpServers", () => ({
  scanMcpServers: vi.fn(),
}));
vi.mock("@/lib/scanner/cicd", () => ({
  scanCiCd: vi.fn(),
}));
vi.mock("@/lib/scanner/worktrees", () => ({
  attachWorktreeOverlays: vi.fn(),
}));

import { promises as fs } from "fs";
import { readConfig } from "@/lib/config";
import { scanPackageJson } from "@/lib/scanner/packageJson";
import { scanEnvFiles } from "@/lib/scanner/envFile";
import { scanDockerCompose } from "@/lib/scanner/dockerCompose";
import { scanGit } from "@/lib/scanner/git";
import { scanClaudeMd } from "@/lib/scanner/claudeMd";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { scanClaudeSessions } from "@/lib/scanner/claudeSessions";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { scanInsightsMd } from "@/lib/scanner/insightsMd";
import { scanClaudeHooks } from "@/lib/scanner/claudeHooks";
import { scanMcpServers } from "@/lib/scanner/mcpServers";
import { scanCiCd } from "@/lib/scanner/cicd";
import { attachWorktreeOverlays } from "@/lib/scanner/worktrees";
import { scanAllProjects } from "@/lib/scanner";

const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);
const mockReadConfig = vi.mocked(readConfig);
const mockScanPackageJson = vi.mocked(scanPackageJson);
const mockScanEnvFiles = vi.mocked(scanEnvFiles);
const mockScanDockerCompose = vi.mocked(scanDockerCompose);
const mockScanGit = vi.mocked(scanGit);
const mockScanClaudeMd = vi.mocked(scanClaudeMd);
const mockScanTodoMd = vi.mocked(scanTodoMd);
const mockScanClaudeSessions = vi.mocked(scanClaudeSessions);
const mockScanManualStepsMd = vi.mocked(scanManualStepsMd);
const mockScanInsightsMd = vi.mocked(scanInsightsMd);
const mockScanClaudeHooks = vi.mocked(scanClaudeHooks);
const mockScanMcpServers = vi.mocked(scanMcpServers);
const mockScanCiCd = vi.mocked(scanCiCd);
const mockAttachWorktreeOverlays = vi.mocked(attachWorktreeOverlays);

/** Build a Dirent-shaped object that satisfies fs.readdir(withFileTypes:true). */
function dirent(name: string): Dirent {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Dirent;
}

/** Configure the mocks so a single project named "my-app" exists at
 *  `C:\dev\my-app`, is a git repo, and every scanner returns a benign
 *  value. The flags map is the only thing tests should vary. */
function setupHappyPath(flags?: MinderConfig["featureFlags"]) {
  mockReadConfig.mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    pinnedSlugs: [],
    featureFlags: flags,
  });
  mockReaddir.mockResolvedValue([dirent("my-app")] as never);
  mockStat.mockResolvedValue({ isDirectory: () => true } as Stats);

  mockScanPackageJson.mockResolvedValue({
    name: "my-app",
    framework: undefined,
    frameworkVersion: undefined,
    orm: undefined,
    styling: undefined,
    monorepoType: undefined,
    dependencies: [],
    devPort: undefined,
  });
  mockScanEnvFiles.mockResolvedValue({
    database: undefined,
    externalServices: [],
  });
  mockScanDockerCompose.mockResolvedValue({ services: ["api"], ports: [] });
  mockScanGit.mockResolvedValue({
    branch: "main",
    isDirty: false,
    uncommittedCount: 0,
  });
  mockScanClaudeMd.mockResolvedValue("CLAUDE.md content");
  mockScanTodoMd.mockResolvedValue({
    total: 1,
    completed: 0,
    pending: 1,
    items: [{ text: "do thing", completed: false, lineNumber: 1 }],
  });
  mockScanClaudeSessions.mockResolvedValue({
    lastSessionDate: "2026-05-01T00:00:00Z",
    lastPromptPreview: "hi",
    sessionCount: 5,
    mostRecentSessionStatus: "idle",
    mostRecentSessionId: "abc",
  });
  mockScanManualStepsMd.mockResolvedValue({
    entries: [],
    totalSteps: 0,
    pendingSteps: 0,
    completedSteps: 0,
  });
  mockScanInsightsMd.mockResolvedValue({ entries: [], total: 0 });
  mockScanClaudeHooks.mockResolvedValue({ entries: [] });
  mockScanMcpServers.mockResolvedValue({ servers: [] });
  mockScanCiCd.mockResolvedValue({
    workflows: [],
    hosting: [],
    vercelCrons: [],
    dependabot: [],
  });
  mockAttachWorktreeOverlays.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scanAllProjects feature-flag gating", () => {
  it("calls every scanner when featureFlags is undefined (default-on)", async () => {
    setupHappyPath(undefined);
    const result = await scanAllProjects();

    expect(result.projects).toHaveLength(1);
    const p = result.projects[0];

    expect(mockScanTodoMd).toHaveBeenCalledTimes(1);
    expect(mockScanInsightsMd).toHaveBeenCalledTimes(1);
    expect(mockScanManualStepsMd).toHaveBeenCalledTimes(1);
    expect(mockScanClaudeSessions).toHaveBeenCalledTimes(1);
    expect(mockScanDockerCompose).toHaveBeenCalledTimes(1);
    expect(mockAttachWorktreeOverlays).toHaveBeenCalledTimes(1);

    expect(p.todos?.pending).toBe(1);
    expect(p.insights?.total).toBe(0);
    expect(p.manualSteps?.totalSteps).toBe(0);
    expect(p.claude?.sessionCount).toBe(5);
    expect(p.claude?.lastSessionDate).toBe("2026-05-01T00:00:00Z");
  });

  it("scanTodos=false skips scanTodoMd and leaves todos undefined", async () => {
    setupHappyPath({ scanTodos: false });
    const result = await scanAllProjects();

    expect(mockScanTodoMd).not.toHaveBeenCalled();
    expect(result.projects[0].todos).toBeUndefined();
    // Other scanners still ran
    expect(mockScanInsightsMd).toHaveBeenCalled();
    expect(mockScanManualStepsMd).toHaveBeenCalled();
  });

  it("scanInsights=false skips scanInsightsMd and leaves insights undefined", async () => {
    setupHappyPath({ scanInsights: false });
    const result = await scanAllProjects();

    expect(mockScanInsightsMd).not.toHaveBeenCalled();
    expect(result.projects[0].insights).toBeUndefined();
    expect(mockScanTodoMd).toHaveBeenCalled();
  });

  it("scanManualSteps=false skips scanManualStepsMd and leaves manualSteps undefined", async () => {
    setupHappyPath({ scanManualSteps: false });
    const result = await scanAllProjects();

    expect(mockScanManualStepsMd).not.toHaveBeenCalled();
    expect(result.projects[0].manualSteps).toBeUndefined();
    expect(mockScanTodoMd).toHaveBeenCalled();
  });

  it("scanClaudeSessions=false skips scanClaudeSessions and substitutes neutral values", async () => {
    setupHappyPath({ scanClaudeSessions: false });
    const result = await scanAllProjects();

    expect(mockScanClaudeSessions).not.toHaveBeenCalled();
    // Neutral substitute: sessionCount 0, no dates, no most-recent fields.
    expect(result.projects[0].claude?.sessionCount).toBe(0);
    expect(result.projects[0].claude?.lastSessionDate).toBeUndefined();
    expect(result.projects[0].claude?.mostRecentSessionId).toBeUndefined();
    // claudeMd still scanned — only the sessions slice is gated.
    expect(result.projects[0].claude?.claudeMdSummary).toBe("CLAUDE.md content");
  });

  it("scanDockerCompose=false skips scanDockerCompose and produces empty docker results", async () => {
    setupHappyPath({ scanDockerCompose: false });
    const result = await scanAllProjects();

    expect(mockScanDockerCompose).not.toHaveBeenCalled();
    expect(result.projects[0].dockerPorts).toEqual([]);
    // Neutral docker substitute: services list dropped, no port mappings.
  });

  it("scanWorktrees=false skips attachWorktreeOverlays at orchestrator level", async () => {
    setupHappyPath({ scanWorktrees: false });
    await scanAllProjects();

    expect(mockAttachWorktreeOverlays).not.toHaveBeenCalled();
    // Per-project scanners untouched by the worktree flag.
    expect(mockScanTodoMd).toHaveBeenCalled();
  });

  it("explicit true and absent map produce the same call counts", async () => {
    setupHappyPath({
      scanInsights: true,
      scanTodos: true,
      scanManualSteps: true,
      scanClaudeSessions: true,
      scanWorktrees: true,
      scanDockerCompose: true,
    });
    await scanAllProjects();

    expect(mockScanTodoMd).toHaveBeenCalledTimes(1);
    expect(mockScanInsightsMd).toHaveBeenCalledTimes(1);
    expect(mockScanManualStepsMd).toHaveBeenCalledTimes(1);
    expect(mockScanClaudeSessions).toHaveBeenCalledTimes(1);
    expect(mockScanDockerCompose).toHaveBeenCalledTimes(1);
    expect(mockAttachWorktreeOverlays).toHaveBeenCalledTimes(1);
  });

  it("non-gated scanners always run regardless of any flag value", async () => {
    // Turn off every scanner-gated flag at once. Non-gated scanners
    // (packageJson, envFile, git, claudeMd, claudeHooks, mcpServers, cicd)
    // must still fire — their flag wiring is intentionally absent today.
    setupHappyPath({
      scanInsights: false,
      scanTodos: false,
      scanManualSteps: false,
      scanClaudeSessions: false,
      scanWorktrees: false,
      scanDockerCompose: false,
    });
    await scanAllProjects();

    expect(mockScanPackageJson).toHaveBeenCalledTimes(1);
    expect(mockScanEnvFiles).toHaveBeenCalledTimes(1);
    expect(mockScanGit).toHaveBeenCalledTimes(1);
    expect(mockScanClaudeMd).toHaveBeenCalledTimes(1);
    expect(mockScanClaudeHooks).toHaveBeenCalledTimes(1);
    expect(mockScanMcpServers).toHaveBeenCalledTimes(1);
    expect(mockScanCiCd).toHaveBeenCalledTimes(1);
  });
});
