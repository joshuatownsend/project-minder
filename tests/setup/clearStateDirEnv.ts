/**
 * Remove `MINDER_STATE_DIR` from the test environment, before any test module
 * is imported.
 *
 * `DB_DIR` (src/lib/db/connection.ts) resolves `MINDER_STATE_DIR` ahead of
 * `os.homedir()`. Around 23 test files isolate their database by spying
 * `os.homedir()` and re-importing the connection module — so on a machine where
 * that variable happens to be set, the env branch wins and every one of those
 * spies is bypassed at once. Two consequences, both bad:
 *
 *   - the suite fails in a way that looks like a code regression (measured at
 *     24 failures) but is purely environmental, and
 *   - far worse, the "isolated" tests would then open the developer's *real*
 *     relocated `index.db` / `tasks.db` and write to them.
 *
 * Deleting the variable here makes the suite behave identically whether or not
 * a developer has it set, and keeps `os.homedir()` as the single thing the DB
 * tests need to control. Note this is the opposite of *setting* it to a temp
 * dir, which would defeat the same spies just as thoroughly.
 *
 * `setupFiles` is the only hook early enough: the paths are module-level
 * constants evaluated on first import, so a `beforeEach` or `vi.stubEnv` inside
 * a test runs too late to matter.
 *
 * Tests that exercise the variable deliberately (`tests/serverRoot.test.ts`)
 * set it inside their own cases and restore afterwards — unaffected, since this
 * runs once before the file loads.
 */
delete process.env.MINDER_STATE_DIR;
