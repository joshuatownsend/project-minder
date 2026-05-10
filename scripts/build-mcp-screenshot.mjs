// Bundles the screenshot-to-code stdio MCP server into a single ESM file
// at `dist/mcp/screenshot-to-code/index.js` with a `#!/usr/bin/env node`
// shebang so `claude mcp add screenshot-to-code -- node …/index.js` can
// spawn it directly.
//
// The MCP SDK is dual-published (ESM + CJS); we bundle as ESM to match the
// SDK's primary entry. The spawned process inherits its env from Claude
// Code, which is where API keys live (the server NEVER reads keys from
// disk — they come from process.env).

import { build } from "esbuild";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "dist", "mcp", "screenshot-to-code");
// .mjs forces Node to load this as ESM regardless of the dist folder's
// (absent) package.json. Switching to .mjs is simpler than emitting a
// dist-side package.json.
const outFile = path.join(outDir, "index.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "mcp", "screenshot-to-code", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  tsconfig: path.join(root, "tsconfig.json"),
  // External the entire MCP SDK + Zod (SDK peer dep). The MCP SDK has a
  // tangled CJS/ESM dependency graph (ajv, ajv-formats, express, etc.)
  // that esbuild cannot interop cleanly — leave it to Node's runtime
  // resolver, same way build-worker.mjs leaves better-sqlite3 external.
  // The MCP server is always invoked from inside the project tree (so
  // node_modules/ is reachable), making this safe.
  packages: "external",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Same shims as build-worker.mjs — MCP SDK reaches for require/__dirname
      // through its CJS dependency graph.
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

// chmod is a no-op on Windows. POSIX needs +x for `node` to invoke the
// shebang-prefixed script directly; the `claude mcp add … -- node …` form
// works without it, but we set it for parity with conventional CLI bins.
try {
  chmodSync(outFile, 0o755);
} catch {
  /* Windows */
}

console.log("[build-mcp-screenshot] bundled to", path.relative(root, outFile));
