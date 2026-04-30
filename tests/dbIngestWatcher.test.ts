import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Watcher integration test. Sets up a tmpdir, starts the watcher
// pointed at it (`bypassEnvFlag` so we don't need to set MINDER_INDEXER),
// writes a JSONL fixture, and asserts the row appears.
//
// Chokidar reliability on Windows + tmpdir is uneven; we flip to
// `usePolling: true` for tests so the test doesn't depend on native FS
// events landing inside the OS temp directory. Production uses native
// events (the default).

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

interface Reloaded {
  conn: typeof import("@/lib/db/connection");
  mig: typeof import("@/lib/db/migrations");
  ingest: typeof import("@/lib/db/ingest");
  watcher: typeof import("@/lib/db/ingestWatcher");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function freshTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-watcher-test-"));
}

async function reloadModulesPointingAt(home: string): Promise<Reloaded> {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __minderIngestWatcher?: unknown }).__minderIngestWatcher;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  const watcher = await import("@/lib/db/ingestWatcher");
  return { conn, mig, ingest, watcher };
}

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(timestamp: string, text: string): JsonlEntry {
  return {
    type: "user",
    timestamp,
    message: { content: [{ type: "text", text }] },
  };
}

function assistantTurn(timestamp: string, model: string, text: string): JsonlEntry {
  return {
    type: "assistant",
    timestamp,
    message: {
      model,
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

/**
 * Wait until `predicate()` returns truthy, polling at `pollMs` intervals.
 * Throws if `timeoutMs` elapses without the predicate matching.
 */
async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeoutMs = 4000, pollMs = 50 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await freshTempHome();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  // Tear down the watcher first so its background timers don't fire
  // against a deleted tmpHome and spam afterEach with errors.
  try {
    const watcherMod = await import("@/lib/db/ingestWatcher");
    await watcherMod.stopIngestWatcher();
  } catch {
    /* ignore — module may not have loaded */
  }
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("ingestWatcher", () => {
  const projectsDirOf = (home: string) => path.join(home, ".claude", "projects");

  it("returns idle status when MINDER_INDEXER is unset and bypass is off", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const original = process.env.MINDER_INDEXER;
    delete process.env.MINDER_INDEXER;
    try {
      const status = await reloaded.watcher.startIngestWatcher();
      expect(status.running).toBe(false);
      expect(status.startedAt).toBeNull();
    } finally {
      if (original !== undefined) process.env.MINDER_INDEXER = original;
    }
  });

  it("runs the initial reconcile when started with bypassEnvFlag", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const projectsDir = projectsDirOf(tmpHome);
    // Pre-create a session so the initial reconcile has something to find.
    await writeJsonl(path.join(projectsDir, "C--dev-pre", "s0.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "before watcher"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);

    const status = await reloaded.watcher.startIngestWatcher({
      projectsDir,
      bypassEnvFlag: true,
      disableSweep: true,
      usePolling: true,
    });
    expect(status.running).toBe(true);
    expect(status.initialReconcileMs).not.toBeNull();

    const db = (await reloaded.conn.getDb())!;
    const count = (db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 's0'")
      .get() as { n: number }).n;
    expect(count).toBe(1);

    await reloaded.watcher.stopIngestWatcher();
    reloaded.conn.closeDb();
  });

  it("ingests a session created after the watcher starts", { timeout: 15000 }, async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const projectsDir = projectsDirOf(tmpHome);
    const subDir = path.join(projectsDir, "C--dev-live");
    await fs.mkdir(subDir, { recursive: true });
    // Pre-create a sentinel file so chokidar's initial scan establishes
    // a watch on subDir; adding the real session JSONL after that is the
    // "after watcher" event we want to test.
    await fs.writeFile(path.join(subDir, "sentinel.txt"), "hi");

    await reloaded.watcher.startIngestWatcher({
      projectsDir,
      bypassEnvFlag: true,
      disableSweep: true,
      usePolling: true,
      awaitWriteFinishMs: 0,
      debounceMs: 50,
    });

    const sessionFile = path.join(subDir, "s1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-04-30T10:00:00Z", "after watcher"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "live"),
    ]);

    const db = (await reloaded.conn.getDb())!;
    await waitFor(
      () =>
        (db
          .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 's1'")
          .get() as { n: number }).n === 1,
      { timeoutMs: 12000, pollMs: 100 }
    );

    const status = reloaded.watcher.getWatcherStatus();
    expect(status.eventsHandled).toBeGreaterThan(0);

    await reloaded.watcher.stopIngestWatcher();
    reloaded.conn.closeDb();
  });

  it("startup error is handled (doesn't crash) and falls back to sweep-only", async () => {
    // Point the watcher at a path that doesn't exist. chokidar should
    // complete (with `ignoreInitial: true` it doesn't error on missing
    // paths — it just fires nothing). Either way: startup must not
    // throw, status reflects the result, no uncaught errors.
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const projectsDir = path.join(tmpHome, "does", "not", "exist");

    const status = await reloaded.watcher.startIngestWatcher({
      projectsDir,
      bypassEnvFlag: true,
      disableSweep: true,
      usePolling: true,
      awaitWriteFinishMs: 0,
      debounceMs: 50,
    });
    // running may be true (chokidar happily watches a non-existent path)
    // or false (fell back to sweep-only). The important contract is that
    // we returned without throwing and the watcher is in a sane state
    // we can stop.
    expect(typeof status.running).toBe("boolean");
    expect(status.errors).toBe(0); // unhandled errors would crash, not increment

    await reloaded.watcher.stopIngestWatcher();
    reloaded.conn.closeDb();
  });

  it("close()s cleanly and is idempotent", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const projectsDir = projectsDirOf(tmpHome);
    await fs.mkdir(projectsDir, { recursive: true });

    await reloaded.watcher.startIngestWatcher({
      projectsDir,
      bypassEnvFlag: true,
      disableSweep: true,
      usePolling: true,
      awaitWriteFinishMs: 50,
      debounceMs: 50,
    });
    await reloaded.watcher.stopIngestWatcher();
    await reloaded.watcher.stopIngestWatcher(); // idempotent

    const status = reloaded.watcher.getWatcherStatus();
    expect(status.running).toBe(false);

    reloaded.conn.closeDb();
  });
});
