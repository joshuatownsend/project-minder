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

/**
 * The dev root to use when the user has not configured one.
 *
 * Prefers a candidate that actually exists over the bare first choice, so a
 * machine with `~/dev` but no `C:\dev` scans the directory it really has
 * instead of a hardcoded convention it doesn't. Falls back to the first
 * candidate when neither exists — in that case nothing is worth scanning
 * anyway and `isFirstRun()` routes the user to setup instead.
 *
 * **A function, not a module-scope constant (#481).** As a constant this ran
 * `existsSync` during IMPORT, which had two consequences a test could not
 * escape: the value was frozen before any `os.homedir()` spy was armed, so the
 * `<home>/dev` candidate was probed against the developer's REAL home; and
 * the default config's `devRoot` — which `readConfig()` returns whenever no
 * config file is found, i.e. every isolated test since #477 — carried that
 * real value.
 * Measured under full isolation: state dir, adapters and hidden list were all
 * correctly isolated while `devRoot` still read `C:\dev`.
 *
 * The divergence is narrow, because when the first candidate exists the probe
 * returns exactly what the fallback would and the machine-dependence cancels.
 * It bites a Windows developer with no `C:\dev` but a `~/dev`, who gets
 * `C:\Users\<name>\dev` where CI gets `C:\dev`.
 *
 * Cost of being lazy: one or two `existsSync` calls per `readConfig()` cache
 * miss (3s TTL) instead of one per process. Nothing imported the old constant
 * — verified by grep across `src`, `tests` and `scripts` — so this is not a
 * public-signature change for any caller.
 */
export function resolveDefaultDevRoot(): string {
  return probeDefaultDevRoot() ?? getDefaultDevRoot();
}

let configCache: { value: MinderConfig; expiresAt: number } | null = null;
const CONFIG_TTL_MS = 3_000;

/**
 * Built per call rather than shared, so `devRoot` is resolved against the
 * filesystem as it is NOW. Callers already spread it, so no caller relied on
 * identity.
 */
function defaultConfig(): MinderConfig {
  return {
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: resolveDefaultDevRoot(),
    pinnedSlugs: [],
  };
}

/** Returns all configured scan roots. Falls back to devRoot for backward compat. */
export function getDevRoots(config: MinderConfig): string[] {
  if (config.devRoots && config.devRoots.length > 0) return config.devRoots;
  return [config.devRoot || resolveDefaultDevRoot()];
}

export async function readConfig(): Promise<MinderConfig> {
  if (configCache && Date.now() < configCache.expiresAt) return configCache.value;
  try {
    const data = await fs.readFile(CONFIG_PATH, "utf-8");
    const value = { ...defaultConfig(), ...JSON.parse(data) };
    configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
    return value;
  } catch {
    const value = { ...defaultConfig() };
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

/**
 * Create the state directory if it isn't there yet.
 *
 * `writeFileAtomic` writes its temp file with a plain `fs.writeFile` and never
 * creates a parent — correct for its other callers, which write into
 * directories that already exist and where a missing parent is a real error
 * worth surfacing (a project's `TODO.md`, a snapshot target). The state dir is
 * different: it is ours, and nothing else is guaranteed to have made it.
 *
 * `initDb` does `mkdir(DB_DIR, { recursive: true })`, which is why this never
 * surfaced — the index is created on virtually every boot and `DB_DIR` is the
 * same directory whenever `MINDER_STATE_DIR` is set. But that is a coincidence
 * of ordering, not a guarantee: with `MINDER_USE_DB=0`, or with the optional
 * `better-sqlite3` dependency absent, nothing creates it, and on a fresh
 * machine the first `setProjectStatus()` would fail with ENOENT.
 *
 * Found by Codex on PR #482, where making the test state dir lazy removed the
 * eager `mkdir` that had been masking it there too.
 */
async function ensureStateDir(): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
}

export async function writeConfig(config: MinderConfig): Promise<void> {
  configCache = null;
  await ensureStateDir();
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
