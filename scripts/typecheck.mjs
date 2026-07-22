// Wrapper around the native TypeScript compiler's `tsc --noEmit` that
// first removes the incremental build cache (`tsconfig.tsbuildinfo`).
// Wired in as `pnpm typecheck` so EVERY check (local, pre-commit, CI)
// sees a clean baseline — a stale `tsbuildinfo` from a different branch
// can mask real type errors the fresh-from-disk run would catch. The
// cache file is in .gitignore.
//
// We run the GA native (Go) compiler, installed under the aliased dep
// `typescript-native` (npm:typescript@^7). It's kept separate from the
// tooling-facing `typescript@^6` — ESLint's typescript-eslint peer still
// caps at <6.1.0 — and invoked by explicit path here so it never collides
// with the `tsc` that `typescript@6` also links into node_modules/.bin.
// (Pre-GA this was `@typescript/native-preview`'s `tsgo`, renamed to `tsc`
// at GA.)
//
// For the fast cached path during tight iteration, run the same binary
// directly: `node node_modules/typescript-native/bin/tsc --noEmit` — its
// incremental mode then reuses the on-disk type info between runs.

import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cachePath = path.join(root, "tsconfig.tsbuildinfo");

await rm(cachePath, { force: true });

// bin/tsc is a Node launcher (`#!/usr/bin/env node`) that execs the
// platform-native binary, so run it through the current node executable —
// cross-platform and independent of node_modules/.bin resolution.
const tscBin = path.join(root, "node_modules", "typescript-native", "bin", "tsc");
const result = spawnSync(process.execPath, [tscBin, "--noEmit"], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
