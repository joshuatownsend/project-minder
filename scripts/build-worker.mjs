// Bundles the ingest worker into a single ESM file at
// `workers/dist/ingestWorker.mjs`. Runs via `predev` and `prebuild`
// so it's always fresh before Next.js starts.
//
// Why a separate bundle:
//   The watcher imports TypeScript modules with mixed value/type
//   imports, the `@/*` path alias, and `import "server-only"`. Node's
//   native strip-types can't transform those at runtime. esbuild does
//   a one-shot bundle that respects tsconfig and produces plain ESM
//   the worker can `import` directly with no loader hooks.
//
//   `better-sqlite3` and `chokidar` ship native components; they stay
//   external so the worker resolves them from `node_modules` at
//   runtime (same as the main thread does today). `server-only` is
//   bundled to a no-op string so the package doesn't need to be
//   installed and Next.js's main-thread guard is unaffected.

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "workers", "dist");
const outFile = path.join(outDir, "ingestWorker.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "lib", "db", "ingestWatcher.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  tsconfig: path.join(root, "tsconfig.json"),
  external: ["better-sqlite3", "chokidar"],
  // Stub `server-only` to an empty module. The package's runtime throw
  // exists to catch accidental client bundling — it's a Next.js server
  // boundary check, irrelevant in a Node worker thread that runs
  // server-side by definition. Next.js still sees the original package
  // specifier in the main thread.
  alias: {
    "server-only": path.join(root, "scripts", "server-only-noop.mjs"),
  },
  // Inject CJS-flavored globals into the ESM bundle:
  //   - `require` from createRequire(import.meta.url) — the watcher's
  //     dependency graph contains `require("better-sqlite3")` (dynamic
  //     CJS require used to make the native binding optional). esbuild's
  //     default __require shim refuses dynamic requires.
  //   - `__dirname` / `__filename` — `migrations.ts` uses `__dirname`
  //     for the primary schema.sql lookup, with a cwd-walk fallback.
  //     The bundled __dirname points at workers/dist/ and the lookup
  //     fails there, but the fallback finds src/lib/db/schema.sql via
  //     the project root.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirnameFn } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameFn(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});

console.log("[build-worker] bundled to", path.relative(root, outFile));
