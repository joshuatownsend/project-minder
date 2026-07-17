/**
 * Boot-time bootstrap (service-mode A1). Warms the same in-memory caches and
 * background watchers that today only start on the first dashboard load
 * (`/api/projects`, `/api/mcp-health`, `/api/manual-steps/changes`), so a
 * headless / service-mode server collects from the moment it starts — no
 * browser visit required.
 *
 * Invoked from `instrumentation-node.ts`'s `startIngest()` — itself dynamically
 * imported from the root `instrumentation.ts`'s `register()` after the
 * `NEXT_RUNTIME === "nodejs"` / `NODE_ENV !== "test"` gates. (Root-level
 * `instrumentation.ts` was pre-existing in this codebase, split into a Node-only
 * sibling to keep `fs`/`child_process`-touching modules out of the Edge trace —
 * this bootstrap hooks into that existing convention rather than adding a
 * second, conflicting `instrumentation.ts`.)
 *
 * Gating (see {@link shouldBootstrap}):
 *   - Default ON when `NODE_ENV === "production"`.
 *   - Opt-in in dev via `MINDER_BOOTSTRAP=1` — a full project scan on every
 *     `next dev` restart / HMR reload would be hostile to the edit loop.
 *   - `MINDER_BOOTSTRAP=0` disables it everywhere, overriding both defaults.
 *
 * Demo mode (`MINDER_DEMO=1` or the `demoMode` feature flag) always skips —
 * demo installs have synthetic `C:\dev\*` paths and must never start real
 * git/scan/watcher work against them.
 *
 * Idempotency: `register()` can fire more than once under dev/HMR (Next.js
 * instrumentation contract), so this module gates on a `globalThis` flag —
 * the same idiom the cache singletons in this codebase already use
 * (`gitStatusCache`, `githubActivityCache`, …) to survive hot reload without
 * spawning duplicate work.
 */

import type { MinderConfig } from "@/lib/types";

const g = globalThis as unknown as { __minderBootstrapped?: boolean };

/** Pure gating decision — exported for unit testing. Takes an explicit env
 *  object (defaulting to `process.env`) so tests don't need to mutate the
 *  real process environment. */
export function shouldBootstrap(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MINDER_BOOTSTRAP === "0") return false;
  if (env.MINDER_BOOTSTRAP === "1") return true;
  return env.NODE_ENV === "production";
}

/** Test-only reset hook — mirrors `claudeStatus/cache.ts`'s `_resetForTesting`. */
export function _resetBootstrapForTesting(): void {
  delete g.__minderBootstrapped;
}

/**
 * Runs the boot-time warm-up exactly once per process (guarded by both the
 * gating check and the `globalThis` idempotency flag). Every subsystem is
 * wrapped in its own try/catch and logs one line — a single subsystem
 * failing (e.g. a corrupt `.minder.json`, an unreadable devRoot) must never
 * prevent the others from starting or crash server boot.
 */
export async function runBootstrap(): Promise<void> {
  if (!shouldBootstrap()) return;
  if (g.__minderBootstrapped) return;
  g.__minderBootstrapped = true;

  const { demoMode } = await import("@/lib/demo/demoMode");
  if (await demoMode()) {
    console.log("[bootstrap] skipped: demo mode is active");
    return;
  }

  console.log("[bootstrap] starting service-mode boot sequence…");

  await bootDb();
  const projects = await bootScan();
  await bootProjectCaches(projects);
  await bootManualStepsWatcher();
  await bootMcpConfigWatcher();
  await bootMcpHealthCache();
  await bootClaudeStatus();

  console.log("[bootstrap] boot sequence complete");
}

async function bootDb(): Promise<void> {
  try {
    const { probeInitStatus } = await import("@/lib/data");
    const status = await probeInitStatus();
    console.log(
      `[bootstrap] db: state=${status.state} attempts=${status.attempts} quarantineRuns=${status.quarantineRuns}`
    );
  } catch (err) {
    console.warn("[bootstrap] db: probe failed —", err);
  }
}

interface ScannedProjects {
  projects: import("@/lib/types").ProjectData[];
  flags: MinderConfig["featureFlags"];
}

async function bootScan(): Promise<ScannedProjects> {
  const { readConfig } = await import("@/lib/config");
  const config = await readConfig();
  try {
    const { scanAllProjects } = await import("@/lib/scanner");
    const { setCachedScan } = await import("@/lib/cache");
    const result = await scanAllProjects();
    setCachedScan(result);
    console.log(`[bootstrap] scan: cached ${result.projects.length} projects`);
    return { projects: result.projects, flags: config.featureFlags };
  } catch (err) {
    console.warn("[bootstrap] scan: failed —", err);
    return { projects: [], flags: config.featureFlags };
  }
}

async function bootProjectCaches({ projects, flags }: ScannedProjects): Promise<void> {
  if (projects.length === 0) return;
  try {
    const { enqueueProjectCaches } = await import("@/lib/projectCacheEnqueue");
    enqueueProjectCaches(projects, flags);
    console.log(
      `[bootstrap] caches: enqueued git-status/efficiency-grade/github-activity for ${projects.length} projects`
    );
  } catch (err) {
    console.warn("[bootstrap] caches: enqueue failed —", err);
  }
}

async function bootManualStepsWatcher(): Promise<void> {
  try {
    const { manualStepsWatcher } = await import("@/lib/manualStepsWatcher");
    await manualStepsWatcher.init();
    console.log("[bootstrap] manualStepsWatcher: started");
  } catch (err) {
    console.warn("[bootstrap] manualStepsWatcher: failed to start —", err);
  }
}

async function bootMcpConfigWatcher(): Promise<void> {
  // `ensureStarted()` is itself idempotent ("safe to call on every
  // /api/mcp-health request"), but the ROUTE it mirrors only ever reaches that
  // call after its own `mcpHealth` flag gate — it returns early otherwise (see
  // `src/app/api/mcp-health/route.ts`). Starting the watcher unconditionally
  // here would start the user-config file watchers even with MCP health
  // disabled, which the route never does. Gate on the same flag, the same way
  // `bootMcpHealthCache` below does.
  try {
    const { readConfig } = await import("@/lib/config");
    const { getFlag } = await import("@/lib/featureFlags");
    const config = await readConfig();
    if (!getFlag(config.featureFlags, "mcpHealth")) {
      console.log("[bootstrap] mcpConfigWatcher: skipped (mcpHealth flag off)");
      return;
    }
    const { mcpConfigWatcher } = await import("@/lib/mcpConfigWatcher");
    mcpConfigWatcher.ensureStarted();
    console.log("[bootstrap] mcpConfigWatcher: started");
  } catch (err) {
    console.warn("[bootstrap] mcpConfigWatcher: failed to start —", err);
  }
}

async function bootMcpHealthCache(): Promise<void> {
  try {
    const { readConfig } = await import("@/lib/config");
    const { getFlag } = await import("@/lib/featureFlags");
    const config = await readConfig();
    if (!getFlag(config.featureFlags, "mcpHealth")) {
      console.log("[bootstrap] mcpHealthCache: skipped (mcpHealth flag off)");
      return;
    }
    // Mirrors GET /api/mcp-health's enqueue exactly (same shared helper), so
    // boot-time probes run in whatever stdio-probe mode
    // (`mcpHealthStdioProbe`) the route would apply — not always the
    // launchability default — and don't get disposed/re-probed on the first
    // route poll. `enqueue()` dedupes against its own TTL cache and in-flight
    // `seen` set, so this is safe to call unconditionally on every boot (and
    // would no-op against an already-warm cache).
    const { enqueueMcpHealth } = await import("@/lib/mcpHealthEnqueue");
    const configured = await enqueueMcpHealth(config.featureFlags);
    console.log(`[bootstrap] mcpHealthCache: enqueued ${configured.length} servers`);
  } catch (err) {
    console.warn("[bootstrap] mcpHealthCache: failed to enqueue —", err);
  }
}

async function bootClaudeStatus(): Promise<void> {
  try {
    const { readConfig } = await import("@/lib/config");
    const { getFlag } = await import("@/lib/featureFlags");
    const config = await readConfig();
    if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
      console.log("[bootstrap] claudeStatus: skipped (claudeStatusAlerts flag off)");
      return;
    }
    // `getCurrentStatus()` is the same call GET /api/claude-status makes:
    // TTL-gated, shares a single in-flight promise across concurrent
    // callers, and is internally defensive (network failure degrades to a
    // stale/disk/empty snapshot, never throws) — idempotent to call here.
    // Fire-and-forget: don't let a slow/unreachable status.claude.com stall
    // the rest of boot.
    const { getCurrentStatus } = await import("@/lib/claudeStatus/cache");
    void getCurrentStatus()
      .then((snapshot) => {
        console.log(`[bootstrap] claudeStatus: primed (source=${snapshot.source})`);
      })
      .catch((err) => {
        console.warn("[bootstrap] claudeStatus: prime failed —", err);
      });
  } catch (err) {
    console.warn("[bootstrap] claudeStatus: failed to start —", err);
  }
}

/**
 * NOT wired at boot time: `skillUpdateCache` (`src/lib/skillUpdateCache.ts`).
 * Unlike `mcpConfigWatcher.ensureStarted()` / `mcpHealthCache.enqueue()` /
 * `claudeStatus.getCurrentStatus()`, it has no standalone idempotent starter —
 * it's only enqueued from inside the `/api/agents` and `/api/skills` catalog
 * query modules (`src/lib/server/queries/{agents,skills}.ts`), each call
 * carrying `buildUpdateItems()` derived from a freshly-built agents/skills
 * catalog (an indexer walk over user/plugin/project sources). Replicating
 * that here to warm a 24h-TTL update-check cache would mean duplicating the
 * catalog-build pipeline at boot for a cache with a very long TTL and no
 * user-facing value until someone opens the Agents/Skills page anyway — out
 * of scope for A1's boot warm-up.
 */
