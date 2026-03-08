import { promises as fs } from "fs";
import path from "path";
import { ProjectData, PortConflict, ScanResult } from "../types";
import { readConfig } from "../config";
import { scanPackageJson } from "./packageJson";
import { scanEnvFiles } from "./envFile";
import { scanDockerCompose } from "./dockerCompose";
import { scanGit } from "./git";
import { scanClaudeMd } from "./claudeMd";
import { scanTodoMd } from "./todoMd";
import { scanClaudeSessions } from "./claudeSessions";

const DEV_ROOT = "C:\\dev";

function toSlug(dirName: string): string {
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

async function scanProject(dirName: string): Promise<ProjectData | null> {
  const projectPath = path.join(DEV_ROOT, dirName);

  if (!(await isGitRepo(projectPath))) return null;

  const slug = toSlug(dirName);

  const [pkgResult, envResult, dockerResult, gitResult, claudeMd, todos, claudeSessions] =
    await Promise.all([
      scanPackageJson(projectPath),
      scanEnvFiles(projectPath),
      scanDockerCompose(projectPath),
      scanGit(projectPath),
      scanClaudeMd(projectPath),
      scanTodoMd(projectPath),
      scanClaudeSessions(projectPath),
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
    },
    todos,
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

  let entries: string[];
  try {
    const dirents = await fs.readdir(DEV_ROOT, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { projects: [], portConflicts: [], hiddenCount: 0, scannedAt: new Date().toISOString() };
  }

  // Filter out hidden projects
  const hiddenSet = new Set(config.hidden.map((h) => h.toLowerCase()));
  entries = entries.filter((e) => !hiddenSet.has(e.toLowerCase()));

  // Process in batches of 10 to avoid overwhelming the system
  const projects: ProjectData[] = [];
  const BATCH_SIZE = 10;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(scanProject));
    for (const r of results) {
      if (r) projects.push(r);
    }
  }

  // Apply saved statuses
  for (const project of projects) {
    if (config.statuses[project.slug]) {
      project.status = config.statuses[project.slug];
    }
  }

  // Sort by last activity descending
  projects.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  const portConflicts = detectPortConflicts(projects);

  return {
    projects,
    portConflicts,
    hiddenCount: config.hidden.length,
    scannedAt: new Date().toISOString(),
  };
}
