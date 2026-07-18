import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dirent, Stats } from "fs";
import type { MinderConfig } from "@/lib/types";
import type { WslRootCheck } from "@/lib/wsl";

// Same orchestrator-mock preamble as scannerFeatureFlags.test.ts: mock fs,
// config, and every scanner module so scanAllProjects() runs against a
// controlled two-root world. Additionally mock @/lib/wsl so tests steer the
// per-root WSL state check without spawning wsl.exe.
vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
  getDevRoots: (config: MinderConfig) => config.devRoots ?? [config.devRoot],
}));

vi.mock("@/lib/wsl", () => ({
  checkWslRoot: vi.fn(),
}));

vi.mock("@/lib/scanner/packageJson", () => ({ scanPackageJson: vi.fn() }));
vi.mock("@/lib/scanner/envFile", () => ({ scanEnvFiles: vi.fn() }));
vi.mock("@/lib/scanner/dockerCompose", () => ({ scanDockerCompose: vi.fn() }));
vi.mock("@/lib/scanner/git", () => ({ scanGit: vi.fn() }));
vi.mock("@/lib/scanner/claudeMd", () => ({ scanClaudeMd: vi.fn() }));
vi.mock("@/lib/scanner/todoMd", () => ({ scanTodoMd: vi.fn() }));
vi.mock("@/lib/scanner/claudeSessions", () => ({ scanClaudeSessions: vi.fn() }));
vi.mock("@/lib/scanner/manualStepsMd", () => ({ scanManualStepsMd: vi.fn() }));
vi.mock("@/lib/scanner/insightsMd", () => ({ scanInsightsMd: vi.fn() }));
vi.mock("@/lib/scanner/boardMd", () => ({ scanBoardMd: vi.fn() }));
vi.mock("@/lib/scanner/operationsMd", () => ({ scanOperationsMd: vi.fn() }));
vi.mock("@/lib/scanner/claudeHooks", () => ({ scanClaudeHooks: vi.fn() }));
vi.mock("@/lib/scanner/mcpServers", () => ({ scanMcpServers: vi.fn() }));
vi.mock("@/lib/scanner/cicd", () => ({ scanCiCd: vi.fn() }));
vi.mock("@/lib/scanner/worktrees", () => ({ attachWorktreeOverlays: vi.fn() }));
vi.mock("@/lib/scanner/projectCatalogCounts", () => ({
  countProjectCatalog: vi.fn().mockResolvedValue({ agentCount: 0, skillCount: 0 }),
}));

import { promises as fs } from "fs";
import { readConfig } from "@/lib/config";
import { checkWslRoot } from "@/lib/wsl";
import { scanPackageJson } from "@/lib/scanner/packageJson";
import { scanEnvFiles } from "@/lib/scanner/envFile";
import { scanDockerCompose } from "@/lib/scanner/dockerCompose";
import { scanGit } from "@/lib/scanner/git";
import { scanClaudeMd } from "@/lib/scanner/claudeMd";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { scanClaudeSessions } from "@/lib/scanner/claudeSessions";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { scanInsightsMd } from "@/lib/scanner/insightsMd";
import { scanBoardMd } from "@/lib/scanner/boardMd";
import { scanOperationsMd } from "@/lib/scanner/operationsMd";
import { scanClaudeHooks } from "@/lib/scanner/claudeHooks";
import { scanMcpServers } from "@/lib/scanner/mcpServers";
import { scanCiCd } from "@/lib/scanner/cicd";
import { scanAllProjects } from "@/lib/scanner";

const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);
const mockReadConfig = vi.mocked(readConfig);
const mockCheckWslRoot = vi.mocked(checkWslRoot);

const WIN_ROOT = "C:\\dev";
const WSL_ROOT = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev";

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

function setup(perRootDirs: Record<string, string[]>) {
  // Benign per-project scanner results (same shapes as scannerFeatureFlags's
  // happy path) — scanProject destructures/chains several of these, so a bare
  // vi.fn() returning undefined would throw.
  const resolved = (fn: unknown, value: unknown) =>
    vi.mocked(fn as (...a: unknown[]) => Promise<unknown>).mockResolvedValue(value);
  resolved(scanPackageJson, { name: undefined, dependencies: [] });
  resolved(scanEnvFiles, { database: undefined, externalServices: [] });
  resolved(scanDockerCompose, { services: [], ports: [] });
  resolved(scanGit, { branch: "main", isDirty: false, uncommittedCount: 0 });
  resolved(scanClaudeMd, null);
  resolved(scanTodoMd, undefined);
  resolved(scanClaudeSessions, { sessionCount: 0 });
  resolved(scanManualStepsMd, undefined);
  resolved(scanInsightsMd, undefined);
  resolved(scanBoardMd, undefined);
  resolved(scanOperationsMd, undefined);
  resolved(scanClaudeHooks, { entries: [] });
  resolved(scanMcpServers, { servers: [] });
  resolved(scanCiCd, { workflows: [], hosting: [], vercelCrons: [], dependabot: [] });
  mockReadConfig.mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: WIN_ROOT,
    devRoots: [WIN_ROOT, WSL_ROOT],
    pinnedSlugs: [],
  });
  mockReaddir.mockImplementation(async (p: unknown) => {
    const dirs = perRootDirs[String(p)];
    if (!dirs) throw new Error("ENOENT");
    return dirs.map(dirent) as never;
  });
  // Every project dir counts as a git repo (isGitRepo stats <dir>/.git).
  mockStat.mockResolvedValue({ isDirectory: () => true } as Stats);
}

function wslState(check: WslRootCheck | null) {
  mockCheckWslRoot.mockImplementation(async (root: string) =>
    root === WSL_ROOT ? check : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Carry-forward state lives on globalThis (survives module reset) — clear it
  // so tests are order-independent.
  (globalThis as Record<string, unknown>).__minderLastGoodRootScans = undefined;
  (globalThis as Record<string, unknown>).__scanCache = undefined;
});

describe("scanAllProjects — skipped WSL roots", () => {
  it("skips a stopped distro's root and reports it in skippedRoots", async () => {
    setup({ [WIN_ROOT]: ["win-app"], [WSL_ROOT]: ["wsl-app"] });
    wslState({ ok: false, distro: "Ubuntu-26.04", reason: "wsl-stopped" });

    const result = await scanAllProjects();
    expect(result.projects.map((p) => p.slug)).toEqual(["win-app"]);
    expect(result.skippedRoots).toEqual([
      { root: WSL_ROOT, reason: "wsl-stopped", distro: "Ubuntu-26.04" },
    ]);
    // The stopped root's filesystem was never touched.
    expect(mockReaddir).not.toHaveBeenCalledWith(WSL_ROOT, expect.anything());
  });

  it("carries the previous successful scan forward when the distro stops", async () => {
    setup({ [WIN_ROOT]: ["win-app"], [WSL_ROOT]: ["wsl-app"] });

    // Cycle 1: distro running — both roots scan.
    wslState({ ok: true, distro: "Ubuntu-26.04" });
    const first = await scanAllProjects();
    expect(first.projects.map((p) => p.slug).sort()).toEqual(["win-app", "wsl-app"]);
    expect(first.skippedRoots).toBeUndefined();

    // Cycle 2: distro stopped — wsl-app must survive from the last good scan
    // (the fresh result overwrites the scan cache, so dropping it here would
    // erase the project from the dashboard).
    wslState({ ok: false, distro: "Ubuntu-26.04", reason: "wsl-stopped" });
    const second = await scanAllProjects();
    expect(second.projects.map((p) => p.slug).sort()).toEqual(["win-app", "wsl-app"]);
    expect(second.skippedRoots).toEqual([
      { root: WSL_ROOT, reason: "wsl-stopped", distro: "Ubuntu-26.04" },
    ]);

    // Cycle 3: distro back — fresh scan again, no skip reported.
    wslState({ ok: true, distro: "Ubuntu-26.04" });
    const third = await scanAllProjects();
    expect(third.projects.map((p) => p.slug).sort()).toEqual(["win-app", "wsl-app"]);
    expect(third.skippedRoots).toBeUndefined();
  });

  it("carries forward for unreadable non-WSL roots too", async () => {
    setup({ [WIN_ROOT]: ["win-app"], [WSL_ROOT]: ["wsl-app"] });
    wslState({ ok: true, distro: "Ubuntu-26.04" });
    await scanAllProjects();

    // Root disappears (e.g. unmounted drive): readdir throws.
    mockReaddir.mockImplementation(async (p: unknown) => {
      if (String(p) === WSL_ROOT) throw new Error("ENOENT");
      return [dirent("win-app")] as never;
    });
    wslState({ ok: true, distro: "Ubuntu-26.04" });
    const result = await scanAllProjects();
    expect(result.projects.map((p) => p.slug).sort()).toEqual(["win-app", "wsl-app"]);
    expect(result.skippedRoots?.[0]?.reason).toBe("unreadable");
  });

  it("reports a never-scanned stopped root without inventing projects", async () => {
    setup({ [WIN_ROOT]: ["win-app"], [WSL_ROOT]: ["wsl-app"] });
    wslState({ ok: false, distro: "Ubuntu-26.04", reason: "wsl-stopped" });

    const result = await scanAllProjects();
    expect(result.projects.map((p) => p.slug)).toEqual(["win-app"]);
    expect(result.skippedRoots).toHaveLength(1);
  });
});
