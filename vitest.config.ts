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
    // affect the module-level DB path constants. See the file for why the
    // suite must not inherit a MINDER_STATE_DIR from the developer's shell.
    setupFiles: ["tests/setup/clearStateDirEnv.ts"],
    testTimeout: 30000,
    execArgv: ["--max-old-space-size=4096"],
    // Cap fork concurrency to avoid Windows VirtualAlloc failures when running
    // 200+ test files in parallel child processes.
    maxWorkers: 8,
  },
});
