import { promises as fs } from "fs";
import path from "path";
import { MinderConfig, ProjectStatus } from "./types";
import { getDefaultDevRoot } from "./platform";
import { writeFileAtomic, withFileLock } from "./atomicWrite";

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
  await writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function getProjectStatus(slug: string): Promise<ProjectStatus> {
  const config = await readConfig();
  return config.statuses[slug] || "active";
}

/**
 * Read-modify-write helper. Use this for any in-place config mutation —
 * locking the whole r/m/w cycle, not just the write, is what prevents lost
 * updates when two concurrent mutations would otherwise read the same
 * starting state and clobber each other.
 *
 * The mutator may either return a new MinderConfig or mutate the passed-in
 * one and return void. Either way, the result (or the mutated input) is
 * written back atomically.
 */
export async function mutateConfig(
  fn: (config: MinderConfig) => Promise<MinderConfig | void> | MinderConfig | void
): Promise<MinderConfig> {
  return withFileLock(CONFIG_PATH, async () => {
    const config = await readConfig();
    const result = await fn(config);
    const next = result ?? config;
    await writeConfig(next);
    return next;
  });
}

export async function setProjectStatus(
  slug: string,
  status: ProjectStatus
): Promise<void> {
  await mutateConfig((config) => {
    config.statuses[slug] = status;
  });
}
