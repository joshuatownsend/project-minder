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
  },
});
