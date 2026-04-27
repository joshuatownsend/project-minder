import { promises as fs } from "fs";
import path from "path";
import { MinderConfig, ProjectStatus } from "./types";
import { getDefaultDevRoot } from "./platform";

const CONFIG_PATH = path.join(process.cwd(), ".minder.json");

export const DEFAULT_DEV_ROOT = getDefaultDevRoot();

const DEFAULT_CONFIG: MinderConfig = {
  statuses: {},
  hidden: [],
  portOverrides: {},
  devRoot: DEFAULT_DEV_ROOT,
  pinnedSlugs: [],
};

/** Returns all configured scan roots. Falls back to devRoot for backward compat. */
export function getDevRoots(config: MinderConfig): string[] {
  if (config.devRoots && config.devRoots.length > 0) return config.devRoots;
  return [config.devRoot || DEFAULT_DEV_ROOT];
}

export async function readConfig(): Promise<MinderConfig> {
  try {
    const data = await fs.readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: MinderConfig): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export async function getProjectStatus(slug: string): Promise<ProjectStatus> {
  const config = await readConfig();
  return config.statuses[slug] || "active";
}

export async function setProjectStatus(
  slug: string,
  status: ProjectStatus
): Promise<void> {
  const config = await readConfig();
  config.statuses[slug] = status;
  await writeConfig(config);
}
