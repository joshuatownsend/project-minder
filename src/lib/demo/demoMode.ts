import "server-only";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";

/**
 * Demo mode — populates every read surface with deterministic synthetic
 * fixtures so first-run installs and marketing screenshots look alive without a
 * real `~/.claude` history or `C:\dev\*` project tree.
 *
 * Two ways to turn it on (either wins):
 *   - `MINDER_DEMO=1` env var — forces demo on with no persisted config write,
 *     the natural switch for CI / screenshot capture / first-run (mirrors the
 *     `MINDER_USE_DB` env-toggle idiom).
 *   - the `demoMode` feature flag — an in-app Settings toggle for live demos.
 *
 * The guard sits at the data-source seams (`scanAllProjects`, the `data/index.ts`
 * façade, the catalog loaders, and the activity-cache routes), ABOVE the DB/file
 * branch — because `MINDER_USE_DB` defaults on, a lower injection point would
 * either be skipped or throw `DbUnavailableError` on a machine with no index.
 */
const ENV_FLAG = "MINDER_DEMO";

/** Sync, env-only check — for the rare caller that can't await (e.g. a cache
 *  producer). The env var is the screenshot/CI switch; the Settings flag needs
 *  the async {@link demoMode}. */
export function demoModeEnv(): boolean {
  return process.env[ENV_FLAG] === "1";
}

/** True when demo mode is active via the env var OR the persisted feature flag.
 *  Async because the config read is; `readConfig()` is cached, so this is a
 *  cheap per-request check. */
export async function demoMode(): Promise<boolean> {
  if (demoModeEnv()) return true;
  const config = await readConfig();
  return getFlag(config.featureFlags, "demoMode", false);
}
