import { promises as fs } from "fs";
import path from "path";
import { MinderConfig, ProjectData, PortConflict, ScanResult } from "../types";
import { readConfig, getDevRoots } from "../config";
import { getFlag } from "../featureFlags";
import { scanPackageJson } from "./packageJson";
import { scanEnvFiles } from "./envFile";
import { scanDockerCompose } from "./dockerCompose";
import { scanGit } from "./git";
import { scanClaudeMd } from "./claudeMd";
import { auditClaudeMd } from "./claudeMdAudit";
import { scanTodoMd } from "./todoMd";
import { scanClaudeSessions } from "./claudeSessions";
import { scanManualStepsMd } from "./manualStepsMd";
import { scanInsightsMd } from "./insightsMd";
import { scanClaudeHooks } from "./claudeHooks";
import { scanMcpServers } from "./mcpServers";
import { scanCiCd } from "./cicd";
import { attachWorktreeOverlays } from "./worktrees";

// Neutral substitutes typed against the real scanner returns so downstream
// code reads the same shape whether the scanner ran or was gated off.
const EMPTY_CLAUDE_SESSIONS: Awaited<ReturnType<typeof scanClaudeSessions>> = {
  sessionCount: 0,
};
const EMPTY_DOCKER: Awaited<ReturnType<typeof scanDockerCompose>> = {
  services: [],
  ports: [],
};

/** Canonical slug derivation for project directories. Exported so the
 *  template-apply layer can synthesize matching slugs for fresh-bootstrap
 *  paths that aren't in the scan yet (otherwise the fallback could drift
 *  from the canonical form and break `?project=<slug>` filtering). */
export function toSlug(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dirPath, ".git"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanProject(
  dirName: string,
  devRoot: string,
  flags: MinderConfig["featureFlags"],
): Promise<ProjectData | null> {
  const projectPath = path.join(devRoot, dirName);

  if (!(await isGitRepo(projectPath))) return null;

  const slug = toSlug(dirName);

  const [
    pkgResult,
    envResult,
    dockerResult,
    gitResult,
    claudeMd,
    claudeMdAudit,
    todos,
    claudeSessions,
    manualSteps,
    insights,
    hooks,
    mcpServers,
    cicd,
  ] = await Promise.all([
    scanPackageJson(projectPath),
    scanEnvFiles(projectPath),
    getFlag(flags, "scanDockerCompose")
      ? scanDockerCompose(projectPath)
      : Promise.resolve(EMPTY_DOCKER),
    scanGit(projectPath),
    scanClaudeMd(projectPath),
    auditClaudeMd(projectPath),
    getFlag(flags, "scanTodos")
      ? scanTodoMd(projectPath)
      : Promise.resolve(undefined),
    getFlag(flags, "scanClaudeSessions")
      ? scanClaudeSessions(projectPath)
      : Promise.resolve(EMPTY_CLAUDE_SESSIONS),
    getFlag(flags, "scanManualSteps")
      ? scanManualStepsMd(projectPath)
      : Promise.resolve(undefined),
    getFlag(flags, "scanInsights")
      ? scanInsightsMd(projectPath)
      : Promise.resolve(undefined),
    scanClaudeHooks(projectPath),
    scanMcpServers(projectPath),
    scanCiCd(projectPath),
  ]);

  // Determine DB port from env or docker
  let dbPort: number | undefined;
  if (envResult.database) {
    dbPort = envResult.database.port;
  }
  for (const p of dockerResult.ports) {
    if ([5432, 3306, 27017, 6379].includes(p.container)) {
      dbPort = dbPort || p.host;
    }
  }

  // Determine last activity
  const dates = [
    gitResult?.lastCommitDate,
    claudeSessions.lastSessionDate,
  ].filter(Boolean) as string[];
  const lastActivity = dates.length > 0
    ? dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    : undefined;

  return {
    slug,
    name: pkgResult.name || dirName,
    path: projectPath,
    status: "active", // Will be overridden from config
    framework: pkgResult.framework,
    frameworkVersion: pkgResult.frameworkVersion,
    orm: pkgResult.orm,
    styling: pkgResult.styling,
    monorepoType: pkgResult.monorepoType,
    dependencies: pkgResult.dependencies,
    devPort: pkgResult.devPort,
    dbPort,
    dockerPorts: dockerResult.ports,
    database: envResult.database,
    externalServices: envResult.externalServices,
    git: gitResult,
    claude: {
      lastSessionDate: claudeSessions.lastSessionDate,
      lastPromptPreview: claudeSessions.lastPromptPreview,
      sessionCount: claudeSessions.sessionCount,
      claudeMdSummary: claudeMd,
      mostRecentSessionStatus: claudeSessions.mostRecentSessionStatus,
      mostRecentSessionId: claudeSessions.mostRecentSessionId,
    },
    claudeMdAudit,
    todos,
    manualSteps,
    insights,
    hooks,
    mcpServers,
    cicd,
    lastActivity,
    scannedAt: new Date().toISOString(),
  };
}

function detectPortConflicts(projects: ProjectData[]): PortConflict[] {
  const portMap = new Map<number, { projects: Set<string>; type: PortConflict["type"] }>();

  function addPort(port: number, projectName: string, type: PortConflict["type"]) {
    const entry = portMap.get(port) || { projects: new Set<string>(), type };
    entry.projects.add(projectName);
    portMap.set(port, entry);
  }

  for (const project of projects) {
    if (project.devPort) addPort(project.devPort, project.name, "dev");
    if (project.dbPort) addPort(project.dbPort, project.name, "db");
    for (const dp of project.dockerPorts) {
      addPort(dp.host, project.name, "docker");
    }
  }

  const conflicts: PortConflict[] = [];
  for (const [port, entry] of portMap) {
    if (entry.projects.size > 1) {
      conflicts.push({ port, projects: Array.from(entry.projects), type: entry.type });
    }
  }

  return conflicts.sort((a, b) => a.port - b.port);
}

export async function scanAllProjects(): Promise<ScanResult> {
  const config = await readConfig();
  const flags = config.featureFlags;
  const devRoots = getDevRoots(config);
  const BATCH_SIZE = Math.max(1, Math.round(config.scanBatchSize ?? 10));
  const hiddenSet = new Set(config.hidden.map((h) => h.toLowerCase()));
  const worktreesEnabled = getFlag(flags, "scanWorktrees");

  const allProjects: ProjectData[] = [];
  // Track slugs seen so far to handle collisions across roots (first root wins)
  const seenSlugs = new Set<string>();

  for (const devRoot of devRoots) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(devRoot, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // Root doesn't exist or isn't readable — skip it
      continue;
    }

    // Keep full list for worktree discovery before filtering
    const allDirNames = [...entries];

    // Filter out hidden projects
    entries = entries.filter((e) => !hiddenSet.has(e.toLowerCase()));

    // Filter out slugs already claimed by an earlier root
    entries = entries.filter((e) => {
      const slug = toSlug(e);
      if (seenSlugs.has(slug)) {
        console.warn(`[scanner] Slug collision: "${e}" in ${devRoot} conflicts with a project in an earlier root — skipping.`);
        return false;
      }
      return true;
    });

    // Process in batches to avoid overwhelming the system
    const rootProjects: ProjectData[] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((d) => scanProject(d, devRoot, flags)));
      for (const r of results) {
        if (r) {
          rootProjects.push(r);
          seenSlugs.add(r.slug);
        }
      }
    }

    if (worktreesEnabled) {
      await attachWorktreeOverlays(rootProjects, allDirNames, devRoot);
    }

    allProjects.push(...rootProjects);
  }

  // Apply saved statuses and port overrides
  for (const project of allProjects) {
    if (config.statuses[project.slug]) {
      project.status = config.statuses[project.slug];
    }
    if (config.portOverrides[project.slug] !== undefined) {
      project.devPort = config.portOverrides[project.slug];
    }
  }

  // Sort by last activity descending
  allProjects.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  const portConflicts = detectPortConflicts(allProjects);

  return {
    projects: allProjects,
    portConflicts,
    hiddenCount: config.hidden.length,
    scannedAt: new Date().toISOString(),
  };
}
