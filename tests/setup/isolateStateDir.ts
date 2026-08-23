/**
 * Point `MINDER_STATE_DIR` at a throwaway directory, before any test module is
 * imported.
 *
 * ## What this replaced, and why the inversion is safe
 *
 * This file used to *delete* the variable (PR #332, `clearStateDirEnv.ts`),
 * because `DB_DIR` (src/lib/db/connection.ts) resolves `MINDER_STATE_DIR` ahead
 * of `os.homedir()`: on a machine where a developer had it set, the env branch
 * won and every `os.homedir()` spy in the suite was bypassed at once — 24
 * measured failures that looked like a code regression, and, far worse,
 * "isolated" tests opening and WRITING the developer's real relocated
 * `index.db` / `tasks.db`.
 *
 * Deleting it fixed that hazard and created a quieter one (#477). With the
 * variable unset, `resolveStateDir()` (src/lib/serverRoot.ts) falls through to
 * `process.cwd()` — under vitest, the repo root. So every test that reached
 * `readConfig()` read the developer's real, git-ignored `.minder.json`, and the
 * three `.cache` writers wrote into the working tree. Measured on the
 * maintainer's machine, inside a fully "isolated" test:
 *
 *     STATE_DIR = C:\dev\project-minder     <- the repo, not a temp dir
 *     ADAPTERS  = ["claude","codex"]        <- real config, branched on by #474
 *     DEVROOT   = C:\dev                    <- real scan root
 *     HIDDEN_N  = 4                         <- personal hidden-projects list
 *
 * Three tests in `dataIndexBuildingGates.test.ts` passed or failed on that
 * `enabledAdapters` value alone. The dangerous direction is the inverse: a test
 * that passes locally *because* the developer's config carries a value, and
 * fails in CI where `.minder.json` is absent.
 *
 * Setting the variable to a temp dir serves the original goal at least as well
 * as deleting it did — a developer's shell value still cannot reach the suite,
 * because it is overwritten rather than merely removed — while closing the
 * `cwd()` fall-through that deletion opened. The old comment here argued
 * against exactly this change ("the opposite of *setting* it to a temp dir,
 * which would defeat the same spies just as thoroughly"). That reasoning held
 * only for an ARBITRARY value: a spy-bypassing value is one that disagrees with
 * `os.homedir()`, and the two isolation helpers now set it to
 * `<tmpHome>/.minder`, which is exactly what the spy produces. They agree by
 * construction, so nothing is bypassed. See `applyIsolationEnv` in
 * `tests/_helpers/isolatedState.ts`.
 *
 * ## Blast radius, measured rather than assumed
 *
 * `MINDER_STATE_DIR` governs `DB_DIR`, `TASKS_DB_DIR` and `resolveStateDir()`.
 * 21 test files spy `os.homedir()` without going through either isolation
 * helper; **none of them touches the DB layer** (checked against
 * `db/connection`, `db/migrations`, `tasksDb`, `initDb`, `DB_DIR`,
 * `TASKS_DB_DIR`). They relocate `~/.claude`, which this variable does not
 * affect. The helper-managed files are handled by the paired change above.
 *
 * That check missed one case, found by verifying a review finding rather than
 * by the grep: a file can isolate a CHILD process by setting `HOME` alone, with
 * no `os.homedir()` spy to find — a spy does not cross a process boundary, but
 * the environment does. `dbWorkerHostPhase2.test.ts` spawns the real bundled
 * worker that way, so pinning this variable outranked its `HOME` and sent the
 * worker's `index.db` here instead of into its own temp home. It now pins
 * `MINDER_STATE_DIR` alongside `HOME`; it is the only such file (measured
 * across every test that assigns `process.env.HOME`).
 *
 * A file that touches the DB with no isolation at all previously opened the
 * developer's real `~/.minder/index.db`; it now lands here instead. That is a
 * side effect worth naming, and it is the safe direction.
 *
 * `setupFiles` is the only hook early enough: the paths are module-level
 * constants evaluated on first import, so a `beforeEach` or `vi.stubEnv` inside
 * a test runs too late to matter.
 *
 * Tests that exercise the variable deliberately (`tests/serverRoot.test.ts`)
 * set and restore it in their own scope, and are unaffected — they capture the
 * ambient value at module load and put it back.
 */
import path from "path";
import os from "os";
import fs from "fs";
import { randomUUID } from "crypto";

// `setupFiles` re-executes for every test file, so anything that must persist
// across files in a worker lives on `globalThis` — module scope is reset with
// the registry, which would re-register the exit handler once per file.
const PREV_DIR_KEY = "__pmSuiteStateDir";
const CLEANUP_FLAG = "__pmSuiteStateCleanup";
const g = globalThis as Record<string, unknown>;

// A FRESH state dir per test file, NAMED but not created. Two review findings
// on PR #482 killed the earlier `<tmpdir>/pm-suite-state/<pid>` scheme, and
// both come down to the same thing: a derived name is only unique while the
// process that owns it is alive.
//
//   - A worker killed or crashed before its `exit` handler runs leaves the
//     directory populated, and pids are REUSED — the replacement worker's
//     `mkdirSync(..., { recursive: true })` then reopens a stale `index.db` /
//     `.minder.json` instead of starting clean (Codex P2).
//   - `pnpm test:watch` keeps worker processes alive across reruns, so the exit
//     handler does not fire between runs at all and every rerun inherits the
//     previous run's state — `dbWorkerHostPhase2.test.ts` starts the real
//     bundled worker, which writes an `index.db` under whatever
//     `MINDER_STATE_DIR` names (Copilot).
//
// A random name answers both: it cannot collide with a dead process's, and a
// rerun re-runs setup and gets a new one.
//
// Not creating it is what keeps that affordable. `MINDER_STATE_DIR` only has to
// NAME a directory: `readConfig()` treats a missing file as defaults, and every
// writer that matters already does its own `mkdir(..., { recursive: true })` —
// `initDb` at `src/lib/db/connection.ts:126`, and the three `.cache` writers.
// `installIsolatedState` has always relied on the same thing, since it never
// pre-creates `<tmpHome>/.minder` and the DB tests work regardless.
//
// This matters because vitest isolates by default: each test FILE gets a fresh
// worker process, so an eagerly-created directory is ~400 directories per run,
// not one. Measured on the first draft of this file — 657 leaked directories
// after two suite runs, of which **6** held anything at all. Naming without
// creating collapses that to the handful that genuinely write state.
const prev = g[PREV_DIR_KEY];
if (typeof prev === "string") {
  try {
    fs.rmSync(prev, { recursive: true, force: true });
  } catch {
    /* ignore — Windows can still hold a sqlite handle from the previous file;
       the sweep below collects whatever is left. */
  }
}

const SUITE_ROOT = path.join(os.tmpdir(), "pm-suite-state");
const SUITE_STATE_DIR = path.join(SUITE_ROOT, `run-${randomUUID()}`);
g[PREV_DIR_KEY] = SUITE_STATE_DIR;
process.env.MINDER_STATE_DIR = SUITE_STATE_DIR;

// Sweep stale leftovers, because the exit handler below cannot be relied on:
// those 657 directories are what happens when it does not fire, and a worker
// pool that terminates its workers is exactly the case where it does not. An
// hour is far longer than any suite run, so this can never collect a directory
// a concurrent worker is still using — the forks of a single run are minutes
// old at most.
try {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of fs.readdirSync(SUITE_ROOT)) {
    const full = path.join(SUITE_ROOT, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* a dir another worker removed between readdir and stat — fine */
    }
  }
} catch {
  /* the root may not exist yet on the very first run — nothing to sweep */
}

if (!g[CLEANUP_FLAG]) {
  g[CLEANUP_FLAG] = true;
  process.on("exit", () => {
    // Reads the CURRENT directory off `globalThis` rather than closing over the
    // one that existed when the handler was registered — by exit time that is
    // the first file's directory, which was removed long ago.
    const last = (globalThis as Record<string, unknown>)[PREV_DIR_KEY];
    if (typeof last !== "string") return;
    try {
      // `force` makes the common case — a file that never wrote state, so the
      // directory was never created — a no-op rather than an ENOENT throw.
      fs.rmSync(last, { recursive: true, force: true });
    } catch {
      /* ignore — Windows can hold a sqlite handle open past exit */
    }
  });
}
