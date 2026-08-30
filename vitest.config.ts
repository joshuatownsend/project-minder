import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` is a Next.js compile-time guard that throws at build
      // time if a server-only module is imported into a client bundle. It
      // has no runtime behavior and isn't installable as a package, so
      // vitest's node environment can't resolve it. Alias to a no-op stub.
      "server-only": path.resolve(__dirname, "tests/fixtures/server-only-stub.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Runs before each test file is imported — the only point early enough to
    // affect the module-level DB and state path constants. See the file for why
    // the suite must neither inherit a MINDER_STATE_DIR from the developer's
    // shell nor fall through to `process.cwd()` without one.
    // Order matters: `pinPricing` explains itself in terms of where
    // `isolateStateDir` puts the pricing cache, and both must run before any
    // test module is imported.
    setupFiles: ["tests/setup/isolateStateDir.ts", "tests/setup/pinPricing.ts"],
    // Pin the hook order this suite depends on rather than inheriting it.
    //
    // `stack` runs `beforeEach` in registration order and `afterEach` in
    // REVERSE, each awaited before the next. Four files rely on that: they call
    // `installIsolatedState()` at module scope (registering its teardown first)
    // and then register an `afterEach` of their own that closes a SQLite handle
    // or stops a watcher. Reverse order means their cleanup runs BEFORE the
    // helper drops the globalThis slot and removes the temp dir — which is what
    // Windows needs, since an open .db blocks the directory removal.
    //
    // This is already vitest's default (verified against 4.1.10, by docs and by
    // a probe asserting the observed sequence). It is written down because the
    // ordering is load-bearing and silent when wrong: `parallel` would let the
    // helper delete `__minderIngestWatcher` while the other hook is still
    // awaiting its dynamic import, leaving a live chokidar watcher on a deleted
    // directory. Raised as a review question on PR #419; the answer is to stop
    // depending on a default.
    sequence: { hooks: "stack" },
    // A starvation guard, NOT a claim that any test here is slow (#536).
    //
    // `tests/api/githubActivityRoute.test.ts` failed a full run at the 30s
    // limit, then passed three times in isolation at 20ms, 28ms and 17ms — for
    // the whole file. It had burned 37 SECONDS of wall clock doing 20ms of
    // work, on a machine simultaneously running a `next build`, a
    // `package-standalone` and a booted packaged server. The worker simply
    // never got scheduled.
    //
    // Lowering `maxWorkers` below the 8 already set would slow every run to fix
    // a case that only appears under heavy external load. Raising the ceiling
    // costs nothing except a slower failure on a genuine hang — which still
    // fails, since a hang is unbounded and this is not. The failure this
    // prevents is a red pre-commit hook on an unrelated change, which teaches
    // people to re-run until green.
    testTimeout: 60000,
    execArgv: ["--max-old-space-size=4096"],
    // Cap fork concurrency to avoid Windows VirtualAlloc failures when running
    // 200+ test files in parallel child processes.
    maxWorkers: 8,
  },
});
