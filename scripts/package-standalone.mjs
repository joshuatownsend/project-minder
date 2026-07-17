// Assembles a self-contained, movable server directory at
// `dist/minder-server/` from a completed `next build`. This is the
// sidecar payload for the planned Tauri tray app (task C0 of
// docs/superpowers/plans/2026-07-16-service-and-tray.md): the tray
// shells out `node server.js` from this directory instead of managing
// a dev server or requiring a full repo checkout + `pnpm install` on
// the target machine.
//
// Usage: `pnpm build && pnpm package:standalone`
// (`prebuild` already runs `build:worker` before `next build`, so the
// worker bundle at workers/dist/ingestWorker.mjs is fresh by the time
// this script runs — it does NOT rebuild anything itself.)
//
// Why this script exists instead of just shipping `.next/standalone/`
// directly:
//
//   1. Next's `output: "standalone"` deliberately excludes `public/`
//      and `.next/static/` (see
//      https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
//      — the docs say to copy them in yourself. That's step 2 below.
//
//   2. pnpm's node_modules is a symlink farm (a flat `.pnpm` content
//      store with symlinks fanning out to it). Next's file tracer
//      preserves that structure inside `.next/standalone/node_modules`
//      instead of dereferencing it — so a plain copy of
//      `.next/standalone` still contains symlinks pointing at absolute
//      paths *inside this checkout's own node_modules*. That directory
//      tree is exactly what a git worktree cleanup deletes, and it's
//      *never* present on a machine that only received `dist/`. We
//      verified this concretely: `realpathSync()` on the copied
//      `better-sqlite3` native binary resolved back into
//      `<repo>/node_modules/.pnpm/...`, not into `.next/standalone`
//      itself. `copyDereferenced()` (step 1, below) walks the tree by
//      hand and resolves every symlink/junction to a real file, which
//      is what makes the output of this script — as opposed to
//      `.next/standalone` on its own — genuinely self-contained and
//      movable. (`fs.cpSync(..., { dereference: true })` looks like
//      the built-in way to do this, but on Windows it only
//      dereferences a top-level symlinked source; nested plain
//      directory *symbolic links* — as opposed to junctions — survive
//      a recursive cpSync untouched. Verified empirically; see the
//      comment on copyDereferenced() below.)
//
//   3. better-sqlite3 ships a prebuilt `.node` binary tied to the
//      Node ABI (`process.versions.modules`) it was compiled against.
//      Because it's listed in `serverExternalPackages`
//      (next.config.ts), Next's tracer does pull it into
//      `.next/standalone/node_modules/better-sqlite3/build/Release/
//      better_sqlite3.node` automatically — this script verifies that
//      rather than assuming it, and copies it explicitly as a fallback
//      if a future Next/pnpm version stops doing so silently.

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  copyFileSync,
  statSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");
const workersDir = path.join(root, "workers");

const outDir = path.join(root, "dist", "minder-server");

// Node engine range this project targets (package.json `engines`).
// better-sqlite3's prebuilt `.node` binary is compiled against a
// specific Node ABI (`process.versions.modules`) — running the
// packaged server under a Node major that doesn't match the one this
// script records below will crash on `require("better-sqlite3")`
// with an "was compiled against a different Node.js version" error.
// Repo CI targets Node 20 and 22; both satisfy this range.
const EXPECTED_NODE_ENGINES = "^20.19.0 || >=22.12.0";

function fail(message) {
  console.error(`[package-standalone] ERROR: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`[package-standalone] ${message}`);
}

// Recursively copies `src` into `dest`, resolving every symlink/junction
// to a real file or directory along the way.
//
// Why not `fs.cpSync(src, dest, { recursive: true, dereference: true })`:
// on Windows, that option dereferences a *top-level* symlinked source
// correctly, but during a recursive directory walk it fails to
// dereference plain directory *symbolic links* (as opposed to
// junctions) nested inside — confirmed empirically: copying a parent
// directory containing a `fs.symlinkSync(target, link, "dir")` child
// left `link` a dangling symlink in the destination, while the
// identical test with `"junction"` worked. pnpm's own node_modules
// uses junctions (fine either way), but Next.js's `.next/standalone`
// output recreates them as plain "SymbolicLink" reparse points when it
// preserves the pnpm store structure — exactly the case cpSync's
// dereference option mishandles. Walking manually with `statSync`
// (which follows links) and `readdirSync` (which Windows/Node resolve
// transparently through reparse points) sidesteps the bug entirely.
function copyDereferenced(src, dest, ancestry = new Set()) {
  const real = realpathSync(src);
  if (ancestry.has(real)) {
    // A symlink cycle (pnpm store self-reference) — skip re-descending
    // rather than recursing forever. Not expected in practice, but
    // cheap to guard against in a build script.
    return;
  }
  const stat = statSync(src); // follows symlinks/junctions
  if (stat.isDirectory()) {
    ancestry.add(real);
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyDereferenced(path.join(src, entry), path.join(dest, entry), ancestry);
    }
    ancestry.delete(real);
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest); // follows symlinks by default
  }
}

if (!existsSync(standaloneDir)) {
  fail(
    `${path.relative(root, standaloneDir)} not found. Run "pnpm build" first ` +
      `(the full flow is: pnpm build && pnpm package:standalone).`
  );
}

// --- 1. Fresh output dir, dereferencing every symlink on the way in ---
//
// `dereference: true` is the load-bearing option here: without it,
// pnpm's symlinked node_modules (both the top-level package symlinks
// and the peer-dependency symlinks inside `.pnpm/*/node_modules/`)
// get copied *as symlinks*, which still point at this checkout's own
// node_modules. `dist/minder-server` would then only work as long as
// that checkout exists at that exact absolute path — the opposite of
// "movable".
step(`Resetting ${path.relative(root, outDir)}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

step(`Copying .next/standalone/* (dereferencing symlinks)`);
copyDereferenced(standaloneDir, outDir);

// --- 2. Manual copies Next's standalone output intentionally omits ---
step("Copying .next/static -> .next/static");
if (!existsSync(staticDir)) {
  fail(`${path.relative(root, staticDir)} not found — was "pnpm build" run?`);
}
copyDereferenced(staticDir, path.join(outDir, ".next", "static"));

step("Copying public/ -> public/");
if (existsSync(publicDir)) {
  copyDereferenced(publicDir, path.join(outDir, "public"));
} else {
  console.warn(`[package-standalone] WARNING: public/ not found, skipping`);
}

// --- 3. Ingest worker bundle ---
//
// Opt-in via MINDER_INDEXER_WORKER=1 (see instrumentation-node.ts).
// `workers/ingestWorker.mjs` dynamic-imports `./dist/ingestWorker.mjs`
// at a path resolved via `path.join(process.cwd(), "workers",
// "ingestWorker.mjs")` (workerHost.ts) — a runtime `new Worker(path)`
// call, not a static import, so Next's file tracer cannot see it and
// never copies `workers/` into `.next/standalone` on its own. Without
// this step, the default (non-worker) in-process chokidar watcher
// still works fine, but flipping MINDER_INDEXER_WORKER=1 against the
// packaged server would fail with a "module not found" the moment it
// tried to spawn the worker thread.
step("Copying workers/ (ingest worker bundle, opt-in via MINDER_INDEXER_WORKER=1)");
if (existsSync(workersDir)) {
  copyDereferenced(workersDir, path.join(outDir, "workers"));
  const bundlePath = path.join(outDir, "workers", "dist", "ingestWorker.mjs");
  if (!existsSync(bundlePath)) {
    console.warn(
      `[package-standalone] WARNING: workers/dist/ingestWorker.mjs missing — ` +
        `"pnpm build" runs "build:worker" via prebuild, so it should exist. ` +
        `MINDER_INDEXER_WORKER=1 will fail against this package until it's rebuilt.`
    );
  }
} else {
  console.warn(`[package-standalone] WARNING: workers/ not found, skipping`);
}

// --- 4. Verify (don't assume) the better-sqlite3 native binary copied ---
const sqliteNodeRel = path.join(
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node"
);
const packagedSqliteNode = path.join(outDir, sqliteNodeRel);
let sqliteNodeHandling = "auto-copied by Next's file tracer (serverExternalPackages)";

if (existsSync(packagedSqliteNode)) {
  step(`Verified better-sqlite3 prebuilt present at ${sqliteNodeRel}`);
} else {
  console.warn(
    `[package-standalone] WARNING: ${sqliteNodeRel} did NOT auto-copy — ` +
      `copying it explicitly from the repo's node_modules.`
  );
  const repoSqliteNode = path.join(root, sqliteNodeRel);
  if (!existsSync(repoSqliteNode)) {
    fail(
      `better-sqlite3 prebuilt not found at ${sqliteNodeRel} in the repo either. ` +
        `Run "pnpm install" (better-sqlite3 is in pnpm.onlyBuiltDependencies, so ` +
        `install should have compiled it) before packaging.`
    );
  }
  mkdirSync(path.dirname(packagedSqliteNode), { recursive: true });
  copyDereferenced(repoSqliteNode, packagedSqliteNode);
  sqliteNodeHandling = "NOT auto-copied — copied explicitly by this script (see BUILD_INFO.json)";
}

// --- 5. Record + verify the Node version this bundle was built with ---
//
// This doesn't (and can't) guarantee the *runtime* host's Node major
// matches — that's a deploy-time concern for whoever runs
// dist/minder-server/server.js. What it does do: fail loudly at
// package time if the Node currently running this script falls
// outside package.json's `engines` range (so a bad build never gets
// shipped in the first place), and it writes BUILD_INFO.json into the
// package so a human (or the future tray app) can compare
// `process.versions.modules` at startup against what better-sqlite3
// was actually compiled against.
const pkgJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const enginesRange = pkgJson.engines?.node ?? EXPECTED_NODE_ENGINES;

function satisfiesEngines(version, range) {
  // Minimal semver-range check for the two OR'd clauses this repo
  // actually uses ("^20.19.0 || >=22.12.0") — not a general semver
  // parser. Falls back to a warning (not a hard failure) for any
  // range shape it doesn't recognize, since this is a best-effort
  // sanity check, not the source of truth (npm/pnpm already enforce
  // `engines` on install).
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  const clauses = range.split("||").map((c) => c.trim());
  return clauses.some((clause) => {
    const caret = clause.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    if (caret) {
      const [, cMajor, cMinor, cPatch] = caret.map(Number);
      if (major !== cMajor) return false;
      if (minor > cMinor) return true;
      if (minor < cMinor) return false;
      return patch >= cPatch;
    }
    const gte = clause.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
    if (gte) {
      const [, gMajor, gMinor, gPatch] = gte.map(Number);
      if (major !== gMajor) return major > gMajor;
      if (minor !== gMinor) return minor > gMinor;
      return patch >= gPatch;
    }
    return null; // unrecognized clause shape
  });
}

const buildNodeVersion = process.version;
const enginesSatisfied = satisfiesEngines(buildNodeVersion, enginesRange);
if (enginesSatisfied === false) {
  fail(
    `This script is running under Node ${buildNodeVersion}, which does not satisfy ` +
      `package.json engines "${enginesRange}". Rebuild with a supported Node major ` +
      `(repo CI uses Node 20 and 22) — the better-sqlite3 prebuilt bundled here is ` +
      `ABI-tied to whichever Node compiled it, and a mismatched runtime major will ` +
      `crash on require("better-sqlite3").`
  );
} else if (enginesSatisfied === null) {
  console.warn(
    `[package-standalone] WARNING: could not verify Node ${buildNodeVersion} against ` +
      `engines "${enginesRange}" (unrecognized range shape) — proceeding anyway.`
  );
} else {
  step(`Node ${buildNodeVersion} satisfies package.json engines "${enginesRange}"`);
}

const buildInfo = {
  packagedAt: new Date().toISOString(),
  builtWithNode: buildNodeVersion,
  builtWithNodeModuleVersion: process.versions.modules, // ABI version (NODE_MODULE_VERSION)
  expectedNodeEngines: enginesRange,
  betterSqlite3: {
    version: pkgJson.optionalDependencies?.["better-sqlite3"] ?? "unknown",
    prebuiltPath: sqliteNodeRel.split(path.sep).join("/"),
    handling: sqliteNodeHandling,
  },
  note:
    "The bundled better-sqlite3 .node prebuilt's ABI (builtWithNodeModuleVersion, " +
    "i.e. NODE_MODULE_VERSION) must match the Node major that RUNS server.js, not " +
    "just the one that satisfies expectedNodeEngines at build/package time. Repo CI " +
    "uses Node 20 and 22, which share NODE_MODULE_VERSION 127/... — verify with " +
    "`node -p process.versions.modules` on both the build machine and the runtime " +
    "host before deploying across a Node major boundary. A mismatch surfaces as " +
    "\"was compiled against a different Node.js version\" the first time an OTel " +
    "or DB-backed route touches better-sqlite3.",
};
writeFileSync(
  path.join(outDir, "BUILD_INFO.json"),
  JSON.stringify(buildInfo, null, 2) + "\n"
);
step("Wrote BUILD_INFO.json");

// --- 6. Startup ABI check wrapper ---
//
// server.js (generated fresh by `next build` every run) is plain CJS
// and unconditionally `require()`s the compiled Next server, which
// transitively `require("better-sqlite3")`s the very first time a
// DB-backed route is hit. If the runtime Node's ABI doesn't match
// what BUILD_INFO.json recorded, that first request 500s with a
// native-module version-mismatch stack trace instead of a clear
// message at boot. Renaming server.js -> server.next.js and writing a
// thin wrapper back at server.js gives us one up front: it's
// regenerated by this script on every package run, so it never goes
// stale relative to the build it's shipped alongside.
const generatedServerPath = path.join(outDir, "server.js");
const renamedServerPath = path.join(outDir, "server.next.js");
if (!existsSync(generatedServerPath)) {
  fail(`${path.relative(root, generatedServerPath)} missing from standalone output.`);
}
cpSync(generatedServerPath, renamedServerPath);
rmSync(generatedServerPath);

const wrapper = `// Generated by scripts/package-standalone.mjs — do not edit by hand.
// Startup ABI check: better-sqlite3's prebuilt .node binary is tied to the
// NODE_MODULE_VERSION it was compiled against (see BUILD_INFO.json). Running
// this package under a mismatched Node major fails opaquely deep inside the
// first DB-backed request; this check fails loudly at boot instead.
const fs = require("node:fs");
const path = require("node:path");

const buildInfoPath = path.join(__dirname, "BUILD_INFO.json");
try {
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  const builtAbi = buildInfo.builtWithNodeModuleVersion;
  const runningAbi = process.versions.modules;
  if (builtAbi && runningAbi && String(builtAbi) !== String(runningAbi)) {
    console.warn(
      \`[minder-server] WARNING: this package was built with Node \${buildInfo.builtWithNode} \` +
        \`(NODE_MODULE_VERSION \${builtAbi}), but is running under Node \${process.version} \` +
        \`(NODE_MODULE_VERSION \${runningAbi}). better-sqlite3's prebuilt binary is ABI-tied \` +
        "to the build Node major — expect a native module version-mismatch crash on the " +
        "first DB-backed request. Rebuild and re-package under a matching Node major, or " +
        "run this package with a Node whose NODE_MODULE_VERSION matches BUILD_INFO.json."
    );
  }
} catch (err) {
  console.warn("[minder-server] could not read BUILD_INFO.json for the startup ABI check:", err.message);
}

require("./server.next.js");
`;
writeFileSync(generatedServerPath, wrapper);
step("Wrote server.js startup-ABI-check wrapper (delegates to server.next.js)");

// --- Summary ---
step(`Done. Package assembled at ${path.relative(root, outDir)}`);
step(`Run with: PORT=4100 HOSTNAME=127.0.0.1 node ${path.join(outDir, "server.js")}`);
