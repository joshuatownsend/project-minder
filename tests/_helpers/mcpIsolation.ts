import { beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Shared isolation hooks for the MCP test suite (#173 Problem A).
//
// Why this exists:
// - Several MCP tools / resources walk `~/.claude/projects/` and the
//   configured devRoot at call time. Without isolation they hit the
//   developer's real filesystem — 281 sessions / 761 MiB and 61 real
//   projects on the maintainer's machine — and routinely blow the
//   SDK request timeout.
// - `~/.minder/index.db` is captured at module-load time by
//   `src/lib/db/connection.ts` (`DB_DIR = path.join(os.homedir(),
//   ".minder")` at the module top). A `vi.spyOn(os, "homedir")`
//   installed inside `beforeEach` is too late: by then the MCP server
//   module was already imported and its transitive `db/connection`
//   import has frozen `DB_PATH` to the real home. We solve that by
//   calling `vi.resetModules()` in setup AND requiring callers to
//   dynamically import `buildMcpServerForTests` (or anything else
//   touching the DB layer) from inside the test, after this hook runs.
//
// Two lifetimes:
// - `installMcpIsolation("perTest")` — beforeEach / afterEach. Use for
//   suites where each test spins up its own client (mcpResources,
//   mcpTools).
// - `installMcpIsolation("perFile")` — beforeAll / afterAll. Use for
//   suites that share a single connection across tests (mcpServer's
//   boot suite).
//
// What gets reset:
//   1. HOME / USERPROFILE → fresh tmp dir with empty .claude/projects/
//   2. `os.homedir()` spy → returns the tmp dir
//   3. `vi.resetModules()` → next dynamic import sees the spied homedir
//      when capturing module-scope `DB_PATH`-like constants
//   4. globalThis cache singletons (`__minderDb`, scan cache, usage
//      caches, in-flight scan promise, session caches) → empty
//   5. The scan cache is pre-populated with an empty `ScanResult` so
//      `getCachedOrFreshScan()` short-circuits the devRoot walk
//
// What teardown does:
//   - vi.restoreAllMocks() to remove the homedir spy
//   - invalidateCache() so we don't leak the empty snapshot to other
//     test files (their setup will repopulate as needed)
//   - Restore HOME / USERPROFILE to their pre-test values
//   - rm -rf the tmp dir
//
// Returns a small accessor object so the test file can read the
// current tmpHome (useful if a test wants to write fixture JSONL
// before invoking the MCP server).

export type IsolationLifetime = "perTest" | "perFile";

export interface McpIsolationHandle {
  /** Returns the active tmp HOME path. Stable for the lifetime selected. */
  tmpHome: () => string;
}

export function installMcpIsolation(
  lifetime: IsolationLifetime = "perTest"
): McpIsolationHandle {
  let tmpHome = "";
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  const setup = async (): Promise<void> => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-mcp-"));
    await fs.mkdir(path.join(tmpHome, ".claude", "projects"), { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    // Drop globalThis singletons that the DB/usage/scan layers cache
    // results on. After `vi.resetModules()`, the next dynamic import of
    // those modules re-evaluates their top-level code with the spied
    // homedir, capturing the tmp DB path instead of the real one.
    const g = globalThis as Record<string, unknown>;
    delete g.__minderDb;
    delete g.__scanCache;
    delete g.__usageCache;
    delete g.__usageFileCache;
    delete g.__usageAllSessionsInFlight;
    delete g.__minderMcpScanInFlight;
    delete g.__sessionsCache;
    delete g.__sessionIndex;
    vi.resetModules();

    // Re-import @/lib/cache from a fresh module instance so the
    // `setCachedScan` we call writes into the same globalThis slot the
    // post-reset MCP modules will read (both module instances key on
    // `globalThis.__scanCache`).
    const { setCachedScan } = await import("@/lib/cache");
    setCachedScan({
      projects: [],
      portConflicts: [],
      hiddenCount: 0,
      scannedAt: new Date().toISOString(),
      catalogLintFindings: [],
    });

    // Initialize an empty `~/.minder/index.db` under the tmp home with
    // the current schema so OTEL/usage queries return empty results
    // instead of throwing "no such table: otel_events". Best-effort —
    // when the `better-sqlite3` driver isn't loadable on the test host,
    // the tools fall back to file-parse and any DB-only assertions in a
    // test will need to skip via `describe.skipIf(!driverAvailable)`.
    try {
      const { initDb } = await import("@/lib/db/migrations");
      await initDb();
    } catch {
      /* driver unavailable — tests that need DB will skip themselves */
    }
  };

  const teardown = async (): Promise<void> => {
    vi.restoreAllMocks();
    try {
      const { invalidateCache } = await import("@/lib/cache");
      invalidateCache();
    } catch {
      /* ignore — cache module may not be loadable in degraded teardown */
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore — Windows can leave file handles locked briefly */
    }
  };

  if (lifetime === "perTest") {
    beforeEach(setup);
    afterEach(teardown);
  } else {
    beforeAll(setup);
    afterAll(teardown);
  }

  return { tmpHome: () => tmpHome };
}
