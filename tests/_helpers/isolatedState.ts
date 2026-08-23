import { beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Shared state isolation for tests that touch `~/.minder` (issue #331).
//
// THE PROBLEM THIS SOLVES
//
// `src/lib/db/connection.ts` resolves its paths ONCE, at module scope:
//
//     export const DB_DIR = process.env.MINDER_STATE_DIR || path.join(os.homedir(), ".minder");
//
// so a test that wants its own database has to arrange for that line to be
// re-evaluated with a controlled `os.homedir()`. Thirty test files did it by
// hand, each repeating the same three load-bearing steps:
//
//     vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
//     vi.resetModules();
//     const { initDb } = await import("@/lib/db/connection");   // dynamic, AFTER the reset
//
// Every step matters and none of them says so locally. Use a static import and
// the constant was already frozen to the real home before the spy existed. Skip
// `resetModules()` and the cached module instance is returned with its old
// constant. Both failures are SILENT: the test passes, having quietly opened —
// and written to — the developer's real `index.db`.
//
// The failure is silent because the DB layer is designed to degrade quietly
// (better-sqlite3 is an optional dependency; a missing table falls back to
// file-parse). Nothing throws to tell you the isolation leaked.
//
// WHAT THIS IS NOT
//
// It is not a fix for the `MINDER_STATE_DIR` hazard described in #331 — that
// one is already handled, globally, by `tests/setup/isolateStateDir.ts`
// (PR #332, inverted in #477), which pins the variable to a throwaway directory
// in `setupFiles` before any test module is imported. Verified when that landed:
// all 30 files pass with the variable set in the shell. This helper re-pins it
// per test anyway (see `envKeys` handling below) so a file is isolated by its
// own construction rather than by a global it doesn't reference.
//
// USAGE
//
//     const state = installIsolatedState();
//
//     it("...", async () => {
//       await state.reload();                              // fresh module graph
//       const { initDb } = await import("@/lib/db/migrations");
//     });
//
// `installIsolatedState()` registers the lifecycle hooks; `state.reload()` is
// what each test calls before its dynamic imports. Keeping those separate
// matches how the migrated files were already written: setup creates the temp
// home once per test, and the reload happens again inside a test whenever it
// needs to observe a module re-initialising (retry paths, migration reruns).

/** Cache key on `globalThis` holding the memoised better-sqlite3 handle. */
const DB_GLOBAL = "__minderDb";

// Named bundles of `globalThis` cache keys, so a migrating file can say what
// layer it exercises instead of listing string literals. These are caches and
// in-flight-promise slots: dropping the reference is always safe, because the
// modules that own them lazily rebuild on next access.
//
// Deliberately NOT offered as a bundle: `__minderWorker`, `__minderDispatcher`
// and `__minderIngestWatcher`. Those hold LIVE resources (a worker thread, an
// interval, fs watchers) rather than cached values, so dropping the reference
// leaks the resource instead of clearing it. The two or three files that touch
// them stop the resource first and then delete the key themselves.
export const USAGE_CACHE_KEYS = [
  "__usageCache",
  "__usageFileCache",
  "__usageAllSessionsInFlight",
  "__claudeUsageCache",
  "__agentCostCache",
] as const;

export const SESSION_CACHE_KEYS = ["__sessionsCache", "__sessionIndex"] as const;

export const SCAN_CACHE_KEYS = ["__scanCache", "__minderMcpScanInFlight"] as const;

export type IsolationLifetime = "perTest" | "perFile";

export interface IsolatedStateOptions {
  /** `mkdtemp` prefix, so a leaked temp dir names the suite that leaked it. */
  prefix?: string;
  /** Extra `globalThis` cache keys to drop on setup and on every `reload()`. */
  extraGlobals?: readonly string[];
  /** Create `<tmpHome>/.claude/projects/`, which session scanners walk. */
  seedClaudeProjects?: boolean;
  /**
   * Extra environment variables to set for the isolated window. `undefined`
   * deletes the variable. Every key is saved and restored in teardown, so a
   * file can say `{ MINDER_USE_DB: "1" }` instead of hand-rolling the
   * save/restore dance a third time.
   */
  env?: Record<string, string | undefined>;
  /**
   * Variables to save and restore WITHOUT setting — for files whose tests set
   * them case by case (`MINDER_USE_DB` is the usual one) and which only need
   * the value not to escape into the next file.
   */
  preserveEnv?: readonly string[];
  /** `beforeEach`/`afterEach` (default) or `beforeAll`/`afterAll`. */
  lifetime?: IsolationLifetime;
}

export interface IsolatedStateHandle {
  /** The active temp HOME. Only valid inside a test (or after setup). */
  tmpHome: () => string;
  /**
   * Reset the module registry and re-arm the `os.homedir()` spy, so the NEXT
   * dynamic import re-evaluates module-scope path constants against the temp
   * home. Call this before importing anything under `@/lib/db`.
   */
  reload: () => Promise<void>;
}

/**
 * Install temp-home isolation for `~/.minder`-backed state.
 *
 * Setup: allocate a temp dir, point `HOME` / `USERPROFILE` / `os.homedir()` at
 * it, pin `MINDER_STATE_DIR` to `<tmpHome>/.minder` (the value the spy itself
 * produces, so the variable cannot outrank it), drop the cached DB handle,
 * apply any `env` overrides.
 *
 * Teardown: restore mocks and every saved variable, then remove the temp dir.
 */
export function installIsolatedState(
  options: IsolatedStateOptions = {}
): IsolatedStateHandle {
  const {
    prefix = "pm-state-",
    extraGlobals = [],
    seedClaudeProjects = false,
    env = {},
    preserveEnv = [],
    lifetime = "perTest",
  } = options;

  // `MINDER_STATE_DIR` is always managed: it takes precedence over the
  // `os.homedir()` spy in `DB_DIR`/`TASKS_DB_DIR`, so leaving a developer's
  // shell value in place would silently redirect an "isolated" test at their
  // real relocated database.
  //
  // It is pinned to `<tmpHome>/.minder` rather than deleted (#477). Deleting it
  // left `resolveStateDir()` — which is `MINDER_STATE_DIR || process.cwd()` —
  // falling through to the repo root, so every test reaching `readConfig()`
  // read the developer's real `.minder.json`. Pinning closes that without
  // weakening anything: `<tmpHome>/.minder` is precisely what the homedir spy
  // produces, so the env branch and the spy branch agree by construction and
  // there is no longer a branch to bypass. `dbMigrations.test.ts` asserts that
  // exact path, and still passes for the same reason it did before.
  //
  // It is NOT a caller option, and passing it is an error rather than a no-op.
  // `reload()` re-applies the isolation invariant and therefore re-pins the
  // variable, so an `env` override would survive setup, be overwritten at the
  // reload every caller has to make, and leave the test quietly resolving state
  // somewhere it did not choose (Codex review, PR #419).
  //
  // Supporting the override instead was considered and rejected: the whole
  // point of managing it is that all thirty files resolve their database the
  // same way, at `<tmpHome>/.minder`. Three of them used to set it to
  // `<tmpHome>` and were migrated off precisely to remove that divergence.
  if ("MINDER_STATE_DIR" in env) {
    throw new Error(
      "installIsolatedState: MINDER_STATE_DIR cannot be set through `env` — " +
        "the helper re-pins it to <tmpHome>/.minder on every reload() so state " +
        "and database both resolve under the temp home. A test that needs to " +
        "exercise MINDER_STATE_DIR itself should set it after reload() and " +
        "restore it in a finally, the way tests/serverRoot.test.ts does."
    );
  }
  const envKeys = Array.from(
    new Set([
      "HOME",
      "USERPROFILE",
      "MINDER_STATE_DIR",
      ...Object.keys(env),
      ...preserveEnv,
    ])
  );

  let tmpHome = "";
  const savedEnv = new Map<string, string | undefined>();

  const clearGlobals = (): void => {
    const g = globalThis as Record<string, unknown>;
    delete g[DB_GLOBAL];
    for (const key of extraGlobals) delete g[key];
  };

  // The isolation invariant: where "home" is, and the guarantee that nothing
  // outranks it. Re-established on every `reload()`, because a reload is the
  // moment module-scope path constants get recaptured and therefore the last
  // point at which anything can still influence them.
  const applyIsolationEnv = (): void => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Pinned, not deleted — see the long note on the guard above. This value is
    // what `path.join(os.homedir(), ".minder")` evaluates to under the spy, so
    // `DB_DIR` and `TASKS_DB_DIR` are unchanged, while `resolveStateDir()` stops
    // falling through to `process.cwd()` and dragging in the repo-root
    // `.minder.json` (#477).
    process.env.MINDER_STATE_DIR = path.join(tmpHome, ".minder");
  };

  // Caller-supplied values are ordinary test setup, applied ONCE. They are
  // deliberately not re-applied by `reload()`: a test is entitled to change
  // one and reload to watch the effect — `gradeSnapshot.test.ts` sets
  // `MINDER_USE_DB=0` mid-test to exercise the degrade path, and an earlier
  // draft of this helper reset it to "1" underneath, so the test asserted a
  // fallback that never ran. Teardown still restores them.
  const applyCallerEnv = (): void => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const reload = async (): Promise<void> => {
    vi.resetModules();
    clearGlobals();
    applyIsolationEnv();
    // Re-arm after `resetModules()`, and after any `vi.restoreAllMocks()` a
    // test made on its own. `os` is a builtin held by reference, so the spy
    // usually survives the reset — re-applying is cheap and removes the need
    // for the caller to know which of those two things is true.
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  };

  const setup = async (): Promise<void> => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);

    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    if (seedClaudeProjects) {
      await fs.mkdir(path.join(tmpHome, ".claude", "projects"), { recursive: true });
    }

    applyIsolationEnv();
    applyCallerEnv();
    clearGlobals();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  };

  const teardown = async (): Promise<void> => {
    vi.restoreAllMocks();
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    clearGlobals();
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore — Windows can hold a sqlite file handle open briefly */
    }
  };

  if (lifetime === "perTest") {
    beforeEach(setup);
    afterEach(teardown);
  } else {
    beforeAll(setup);
    afterAll(teardown);
  }

  return { tmpHome: () => tmpHome, reload };
}
