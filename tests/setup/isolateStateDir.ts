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

// Scoped by pid so the 8 parallel forks never share a state dir — two forks
// writing `.cache/claude-stats.json` concurrently is a torn file, and a shared
// `index.db` would let one file's rows leak into another's. Files WITHIN a fork
// do share it, which matches the pre-existing situation (they shared the real
// `~/.minder`) and is what `dbIsolationGuard.test.ts` exists to police.
const SUITE_STATE_DIR = path.join(os.tmpdir(), "pm-suite-state", String(process.pid));

fs.mkdirSync(SUITE_STATE_DIR, { recursive: true });
process.env.MINDER_STATE_DIR = SUITE_STATE_DIR;

// `setupFiles` re-executes for every test file, so the guard lives on
// `globalThis` rather than in module scope — a module-level flag would be reset
// along with the registry and register one handler per file.
const CLEANUP_FLAG = "__pmSuiteStateCleanup";
const g = globalThis as Record<string, unknown>;
if (!g[CLEANUP_FLAG]) {
  g[CLEANUP_FLAG] = true;
  process.on("exit", () => {
    try {
      fs.rmSync(SUITE_STATE_DIR, { recursive: true, force: true });
    } catch {
      /* ignore — Windows can hold a sqlite handle open past exit */
    }
  });
}
