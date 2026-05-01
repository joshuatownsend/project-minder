import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs, existsSync } from "fs";
import { execFileSync } from "child_process";

// Phase-2 worker integration test. Spawns the real worker entry
// (workers/ingestWorker.mjs → workers/dist/ingestWorker.mjs) against
// a tmpdir projects root and verifies the watcher actually starts
// inside the worker. Distinct from the phase-1 lifecycle suite which
// uses inline trivial workers.
//
// Requires: better-sqlite3 + chokidar both load (skipped otherwise),
// and the esbuild bundle to exist or be buildable. The vitest config
// stubs `server-only`, so we don't need to worry about that here —
// we're testing the worker entry with its own bundle, not the source
// modules directly.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("chokidar");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const repoRoot = path.resolve(__dirname, "..");
const workerEntry = path.join(repoRoot, "workers", "ingestWorker.mjs");
const bundlePath = path.join(repoRoot, "workers", "dist", "ingestWorker.mjs");
const buildScript = path.join(repoRoot, "scripts", "build-worker.mjs");

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function reloadHost() {
  vi.resetModules();
  delete (globalThis as { __minderWorker?: unknown }).__minderWorker;
  return await import("@/lib/db/workerHost");
}

beforeAll(() => {
  if (!driverAvailable) return;
  if (!existsSync(bundlePath)) {
    // Build on-demand. CI will normally have the predev/prebuild hook
    // run before this, but vitest can be invoked directly without
    // those hooks firing. Hard-coded args; no user input.
    execFileSync(process.execPath, [buildScript], { cwd: repoRoot, stdio: "inherit" });
  }
}, 60_000);

afterEach(async () => {
  try {
    const mod = await import("@/lib/db/workerHost");
    await mod.stopWorker();
  } catch {
    /* fine */
  }
  if (tmpHome) {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe.skipIf(!driverAvailable)("workerHost + real bundle (phase 2)", () => {
  it("spawns the bundled worker, starts the watcher, and stops cleanly", { timeout: 30_000 }, async () => {
    // Use a tmp HOME so the worker's DB lands in a throwaway location
    // instead of touching the real ~/.minder/index.db.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-phase2-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const projectsDir = path.join(tmpHome, "projects");
    await fs.mkdir(projectsDir, { recursive: true });

    const host = await reloadHost();
    const status = await host.startWorker({
      workerEntry,
      sendStart: true,
      watcherOptions: {
        projectsDir,
        disableSweep: true,
        usePolling: true,
        debounceMs: 50,
        awaitWriteFinishMs: 50,
      },
      startTimeoutMs: 15_000,
    });

    expect(status.running).toBe(true);
    expect(status.lastReadyAt).not.toBeNull();
    await host.stopWorker();
    expect(host.getWorkerStatus().running).toBe(false);
  });
});
