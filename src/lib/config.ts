import { promises as fs } from "fs";
import path from "path";
import { MinderConfig, ProjectStatus } from "./types";
import { getDefaultDevRoot, probeDefaultDevRoot } from "./platform";
import { writeFileAtomic, withFileLock } from "./atomicWrite";
import { resolveStateDir } from "./serverRoot";

// User prefs are WRITABLE state — resolve under the state dir (which the tray
// points at ~/.minder for packaged sidecars), NOT process.cwd(): a packaged
// server chdirs into its own read-only/versioned bundle, so cwd there would
// bury (or fail to write) `.minder.json`. Repo runs keep the repo-root path.
const CONFIG_PATH = path.join(resolveStateDir(), ".minder.json");

// Prefer a candidate that actually exists over the bare first choice, so a
// machine with `~/dev` but no `C:\dev` scans the directory it really has
// instead of a hardcoded convention it doesn't. Falls back to the first
// candidate when neither exists — in that case nothing is worth scanning
// anyway and `isFirstRun()` routes the user to setup instead.
export const DEFAULT_DEV_ROOT = probeDefaultDevRoot() ?? getDefaultDevRoot();

let configCache: { value: MinderConfig; expiresAt: number } | null = null;
const CONFIG_TTL_MS = 3_000;

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
  if (configCache && Date.now() < configCache.expiresAt) return configCache.value;
  try {
    const data = await fs.readFile(CONFIG_PATH, "utf-8");
    const value = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
    return value;
  } catch {
    const value = { ...DEFAULT_CONFIG };
    configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
    return value;
  }
}

/**
 * True when this looks like a brand-new install with nowhere to scan — the
 * signal the dashboard uses to show first-run setup instead of an empty grid.
 *
 * Both halves matter:
 *
 *   - **No `.minder.json` on disk.** Anyone who has saved config once has
 *     completed setup, so we must never interrupt them again — not even if
 *     their roots are temporarily unreachable (an unplugged drive, a stopped
 *     WSL distro). Note this checks the FILE, not `readConfig()`, which
 *     always succeeds by falling back to defaults and so can't distinguish
 *     "no config" from "default config".
 *   - **No candidate root exists.** A fresh install on a machine that already
 *     has `C:\dev` or `~/dev` needs no interruption — we can just scan it.
 *
 * Deliberately NOT first-run: a configured root that exists but is empty.
 * That's a legitimate steady state (you deleted your last project), and
 * hijacking the dashboard for it would be a bug.
 */
export async function isFirstRun(): Promise<boolean> {
  try {
    await fs.access(CONFIG_PATH);
    return false;
  } catch (err) {
    // Only a genuinely ABSENT config means "never set up". Any other errno
    // (EACCES, EPERM, EIO, EBUSY) means a config file most likely EXISTS but
    // couldn't be reached this instant — and treating that as first-run would
    // hijack a long-time user's dashboard over a transient permissions or I/O
    // blip, with `FirstRunSetup`'s save then overwriting the real config they
    // still have. Failing closed keeps the guarantee this doc comment makes:
    // anyone who has saved config once is never interrupted again.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // ENOTDIR counts as absent too: a non-directory parent component means the
    // file cannot exist at that path.
    if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    return probeDefaultDevRoot() === null;
  }
}

export async function writeConfig(config: MinderConfig): Promise<void> {
  configCache = null;
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
