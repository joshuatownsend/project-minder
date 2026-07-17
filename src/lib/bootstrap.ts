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
import { serviceLog, initServiceLog } from "@/lib/serviceLog";

/** Recorded so `GET /api/health` can report what the boot sequence started. */
interface BootstrapStatus {
  ran: boolean;
  subsystems: string[];
}

const g = globalThis as unknown as {
  __minderBootstrapped?: boolean;
  __minderBootstrapStatus?: BootstrapStatus;
};

/** Structured bootstrap log line — tees to console and (in service mode) to
 *  `~/.minder/logs/minder.log` via {@link serviceLog}. */
function blog(msg: string, extra?: Record<string, unknown>): void {
  serviceLog({ level: "info", subsystem: "bootstrap", msg, ...extra });
}
function bwarn(msg: string, err?: unknown): void {
  serviceLog({
    level: "warn",
    subsystem: "bootstrap",
    msg,
    error: err instanceof Error ? err.message : err != null ? String(err) : undefined,
  });
}

/** Note a subsystem that successfully started, for the /api/health snapshot. */
function recordSubsystem(name: string): void {
  g.__minderBootstrapStatus?.subsystems.push(name);
}

/** Snapshot of whether the boot sequence ran and which subsystems it started.
 *  Read by `GET /api/health`; safe to call before bootstrap (reports
 *  `{ ran: false, subsystems: [] }`). */
export function getBootstrapStatus(): BootstrapStatus {
  return g.__minderBootstrapStatus ?? { ran: false, subsystems: [] };
}

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
  delete g.__minderBootstrapStatus;
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
    // demoMode check runs before initServiceLog so a demo install never
    // creates ~/.minder/logs — this line only tees to console.
    blog("skipped: demo mode is active");
    return;
  }

  g.__minderBootstrapStatus = { ran: true, subsystems: [] };

  // --- Install shutdown handling FIRST, before any long boot work (F14). ---
  // A supervisor/tray stopping the process mid-boot must still run the
  // disposers registered so far (WAL checkpointed, watchers closed) instead of
  // getting default-kill semantics. Disposers registered here are lazy and
  // idempotent, so registering them before their subsystems have started is
  // safe — disposing an unstarted watcher / a closed DB is a no-op.

  // Turn on file logging first so the shutdown lines land in the file log too.
  // Guarded out of the vitest runner so unit tests never spray files into
  // ~/.minder.
  if (!process.env.VITEST) initServiceLog();

  await registerServiceDisposers();
  const { installSignalHandlers, isShuttingDown } = await import("@/lib/lifecycle");
  // Real signal handlers are only meaningful in a running server; skip them
  // under vitest so the test runner's own SIGINT handling stays intact.
  if (!process.env.VITEST) installSignalHandlers();

  // stdin control channel (C1): the tray app can't deliver a graceful signal to
  // a console Node child on Windows, so it writes `shutdown\n` (or closes the
  // pipe) to ask for a clean stop that runs the same disposers as SIGINT.
  // Opt-in via MINDER_CONTROL_STDIN=1 (the tray sets it for spawned children);
  // inert otherwise. Skipped under vitest so the runner keeps its own stdin.
  if (!process.env.VITEST) {
    try {
      const { initControlChannel } = await import("@/lib/controlChannel");
      initControlChannel();
    } catch (err) {
      bwarn("controlChannel: failed to init", err);
    }
  }

  blog("starting service-mode boot sequence…");

  // Gate each subsequent boot step on isShuttingDown(): if a signal arrived
  // mid-boot, stop starting new subsystems (which would keep writing / open
  // fs.watch handles after the disposers already ran).
  await bootDb();
  if (isShuttingDown()) return abortBoot();
  const projects = await bootScan();
  if (isShuttingDown()) return abortBoot();
  await bootProjectCaches(projects);
  if (isShuttingDown()) return abortBoot();
  await bootManualStepsWatcher();
  if (isShuttingDown()) return abortBoot();
  await bootMcpConfigWatcher();
  if (isShuttingDown()) return abortBoot();
  await bootMcpHealthCache();
  if (isShuttingDown()) return abortBoot();
  await bootClaudeStatus();

  blog("boot sequence complete", { subsystems: getBootstrapStatus().subsystems });
}

/** Logged bail-out when a shutdown signal arrives mid-boot. */
function abortBoot(): void {
  blog("boot aborted: shutdown began mid-sequence — remaining subsystems skipped", {
    subsystems: getBootstrapStatus().subsystems,
  });
}

/**
 * Register the graceful-shutdown disposers (A2). Registration ORDER matters:
 * the registry disposes LIFO, so registering the two SQLite closes FIRST makes
 * them dispose LAST — after every watcher/timer/child that might still write
 * through a DB has been torn down. Each disposer lazily grabs its already-
 * loaded singleton; `onShutdown` is idempotent by name, so a dev/HMR re-run
 * replaces rather than duplicates.
 */
async function registerServiceDisposers(): Promise<void> {
  try {
    const { onShutdown } = await import("@/lib/lifecycle");

    // Registered first → disposed last. The two DBs close after every producer
    // has stopped: the index DB (ingest/scan writers) and the separate
    // tasks.db (the dispatcher). tasks.db is registered just after the index
    // DB and just BEFORE the dispatcher, so LIFO disposes it AFTER the
    // dispatcher stops (no writer left) but alongside the index-DB close.
    onShutdown("sqlite", async () => {
      const { checkpointAndCloseDb } = await import("@/lib/db/connection");
      checkpointAndCloseDb();
    });
    onShutdown("tasksDb", async () => {
      const { checkpointAndCloseTasksDb } = await import("@/lib/tasksDb/connection");
      await checkpointAndCloseTasksDb();
    });
    onShutdown("dispatcher", async () => {
      const { isDispatcherRunning, stopDispatcher } = await import("@/lib/tasks/dispatcher");
      // await: stopDispatcher() resolves once any in-flight tick has settled,
      // so tasks.db (disposed right after this) closes with no writer active.
      if (isDispatcherRunning()) await stopDispatcher();
    });
    onShutdown("gitStatusCache", async () => {
      const { gitStatusCache } = await import("@/lib/gitStatusCache");
      gitStatusCache.dispose();
    });
    onShutdown("githubActivityCache", async () => {
      const { githubActivityCache } = await import("@/lib/githubActivityCache");
      githubActivityCache.dispose();
    });
    onShutdown("manualStepsWatcher", async () => {
      const { manualStepsWatcher } = await import("@/lib/manualStepsWatcher");
      manualStepsWatcher.destroy();
    });
    // Registered last → disposed first.
    onShutdown("mcpConfigWatcher", async () => {
      const { mcpConfigWatcher } = await import("@/lib/mcpConfigWatcher");
      mcpConfigWatcher.dispose();
    });

    recordSubsystem("lifecycle");
    blog("lifecycle: registered shutdown disposers");
  } catch (err) {
    bwarn("lifecycle: failed to register disposers", err);
  }
}

async function bootDb(): Promise<void> {
  try {
    const { probeInitStatus } = await import("@/lib/data");
    const status = await probeInitStatus();
    blog("db: probed", {
      state: status.state,
      attempts: status.attempts,
      quarantineRuns: status.quarantineRuns,
    });
    recordSubsystem("db");
  } catch (err) {
    bwarn("db: probe failed", err);
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
    blog("scan: cached projects", { count: result.projects.length });
    recordSubsystem("scan");
    return { projects: result.projects, flags: config.featureFlags };
  } catch (err) {
    bwarn("scan: failed", err);
    return { projects: [], flags: config.featureFlags };
  }
}

async function bootProjectCaches({ projects, flags }: ScannedProjects): Promise<void> {
  if (projects.length === 0) return;
  try {
    const { enqueueProjectCaches } = await import("@/lib/projectCacheEnqueue");
    enqueueProjectCaches(projects, flags);
    blog("caches: enqueued git-status/efficiency-grade/github-activity", {
      count: projects.length,
    });
    recordSubsystem("projectCaches");
  } catch (err) {
    bwarn("caches: enqueue failed", err);
  }
}

async function bootManualStepsWatcher(): Promise<void> {
  try {
    const { manualStepsWatcher } = await import("@/lib/manualStepsWatcher");
    await manualStepsWatcher.init();
    blog("manualStepsWatcher: started");
    recordSubsystem("manualStepsWatcher");
  } catch (err) {
    bwarn("manualStepsWatcher: failed to start", err);
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
      blog("mcpConfigWatcher: skipped (mcpHealth flag off)");
      return;
    }
    const { mcpConfigWatcher } = await import("@/lib/mcpConfigWatcher");
    mcpConfigWatcher.ensureStarted();
    blog("mcpConfigWatcher: started");
    recordSubsystem("mcpConfigWatcher");
  } catch (err) {
    bwarn("mcpConfigWatcher: failed to start", err);
  }
}

async function bootMcpHealthCache(): Promise<void> {
  try {
    const { readConfig } = await import("@/lib/config");
    const { getFlag } = await import("@/lib/featureFlags");
    const config = await readConfig();
    if (!getFlag(config.featureFlags, "mcpHealth")) {
      blog("mcpHealthCache: skipped (mcpHealth flag off)");
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
    blog("mcpHealthCache: enqueued servers", { count: configured.length });
    recordSubsystem("mcpHealthCache");
  } catch (err) {
    bwarn("mcpHealthCache: failed to enqueue", err);
  }
}

async function bootClaudeStatus(): Promise<void> {
  try {
    const { readConfig } = await import("@/lib/config");
    const { getFlag } = await import("@/lib/featureFlags");
    const config = await readConfig();
    if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
      blog("claudeStatus: skipped (claudeStatusAlerts flag off)");
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
        blog("claudeStatus: primed", { source: snapshot.source });
      })
      .catch((err) => {
        bwarn("claudeStatus: prime failed", err);
      });
    recordSubsystem("claudeStatus");
  } catch (err) {
    bwarn("claudeStatus: failed to start", err);
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
