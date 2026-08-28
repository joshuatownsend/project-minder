import { beforeEach, afterEach } from "vitest";

/**
 * Save the listed environment variables before each test and put them back
 * after, whatever the test did to them.
 *
 * **Why deleting is not a teardown (#421).** The common shape here is a file
 * that sets `process.env.X` in a test and `delete`s it in `afterEach`. That is
 * correct when `X` started unset and lossy when it did not — vitest reuses a
 * worker across files, so an inherited value erased this way is gone for every
 * file that runs afterwards in that worker. Unlike an assignment, nothing puts
 * it back. `CODEX_HOME` is the most plausible to be genuinely set on a
 * developer's machine; provider API keys are next.
 *
 * The severity is low — no test should depend on an ambient `CODEX_HOME` or an
 * API key — but the failure mode is the silent cross-file kind that #331 and
 * #419 exist to remove, and `dbIsolationGuard` reported the suite clean while
 * it happened.
 *
 * `installIsolatedState`'s `preserveEnv` does the same job for files that need
 * the rest of that helper (a temp home, module-registry resets). This exists
 * for the ones that only need the environment put back, so they do not have to
 * take a temp `$HOME` they have no use for.
 *
 *     preserveEnvVars(["CODEX_HOME"]);
 *
 * Registers its own hooks, so call it at describe/file scope, once.
 */
export function preserveEnvVars(names: readonly string[]): void {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of names) saved.set(name, process.env[name]);
  });

  afterEach(() => {
    for (const name of names) {
      const original = saved.get(name);
      // `undefined` means it was genuinely unset when we arrived, so deleting
      // IS the restoration. Any other value has to be written back.
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
}
