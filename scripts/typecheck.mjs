// Wrapper around `tsgo --noEmit` that first removes the incremental
// build cache (`tsconfig.tsbuildinfo`). Local `npm run typecheck` keeps
// the cache between runs (fast iteration); CI / pre-commit runs through
// this wrapper so a stale cache can never produce a false-clean
// typecheck. The cache file is in .gitignore.
//
// Why bother: tsgo's incremental mode reuses on-disk type info from the
// previous run. If the previous run was on a different branch (or used
// a now-stale dependency tree), the cache can mask real type errors
// the fresh-from-disk typecheck would catch.

import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cachePath = path.join(root, "tsconfig.tsbuildinfo");

await rm(cachePath, { force: true });

// Run tsgo via the same toolchain `npx` would resolve. spawnSync
// inherits stdio so output (and exit code) match the bare invocation.
const result = spawnSync("npx", ["tsgo", "--noEmit"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
