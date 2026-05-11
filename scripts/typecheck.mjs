// Wrapper around `tsgo --noEmit` that first removes the incremental
// build cache (`tsconfig.tsbuildinfo`). Wired in as `npm run typecheck`
// so EVERY check (local, pre-commit, CI) sees a clean baseline — a
// stale `tsbuildinfo` from a different branch can mask real type
// errors the fresh-from-disk run would catch. The cache file is in
// .gitignore.
//
// For the fast cached path during tight iteration, hit `npx tsgo
// --noEmit` directly — tsgo's incremental mode then reuses the on-disk
// type info between runs.

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
