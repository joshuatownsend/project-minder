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
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require_ = createRequire(import.meta.url);

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

// --- 2a2. instrumentation.js (Next's own tracer omits this from standalone too) ---
//
// PR #285 review follow-up (Codex P2 investigation): `next build`
// compiles `instrumentation.ts` to `.next/server/instrumentation.js`,
// and the standalone `server.js` (via `next/dist/server/lib/start-
// server`) loads it from `<outDir>/.next/server/instrumentation.js` at
// boot to run our `register()` hook — but Next's own file tracer does
// NOT copy this file (or its sibling `instrumentation/` manifest dir)
// into `.next/standalone` on its own. This is a known Next.js
// `output: "standalone"` gap, not specific to this repo.
//
// Without it, `register()` — and therefore `startIngest()`, and
// therefore EVERYTHING in instrumentation-node.ts (the ingest worker,
// the in-process chokidar fallback, bootstrapMinder, the task
// dispatcher) — silently never runs against a packaged build. This
// isn't just the worker-cwd-anchoring bug the review flagged; it's why
// that bug was undetectable by "does the server boot and answer
// health checks" alone, and it must be fixed for MINDER_INDEXER_WORKER
// (or even the default indexer) to do anything at all in production.
//
// instrumentation.js is a thin Turbopack loader that itself requires
// further hashed chunk files under .next/server/chunks/ — chunks that,
// same root cause, were never traced either (nothing else in the
// per-route trace graph references them). Rather than reverse-engineer
// which specific hashed chunk names instrumentation.js happens to need
// this build (a moving target), copy the ENTIRE chunks/ directory:
// most of it is already present from the normal per-route trace, this
// just fills the gap, and at ~54 MB total it's a modest addition to an
// already-hundreds-of-MB self-contained package.
const instrumentationSrc = path.join(root, ".next", "server", "instrumentation.js");
if (!existsSync(instrumentationSrc)) {
  fail(
    `${path.relative(root, instrumentationSrc)} not found — was "pnpm build" run with ` +
      `instrumentation.ts present? Without it, the ingest worker, the in-process watcher, ` +
      `and boot-time bootstrap never run against this package.`
  );
}
step("Copying .next/server/instrumentation.js (Next's tracer omits it from standalone)");
copyDereferenced(instrumentationSrc, path.join(outDir, ".next", "server", "instrumentation.js"));
const instrumentationMapSrc = `${instrumentationSrc}.map`;
if (existsSync(instrumentationMapSrc)) {
  copyDereferenced(instrumentationMapSrc, path.join(outDir, ".next", "server", "instrumentation.js.map"));
}
const instrumentationManifestDir = path.join(root, ".next", "server", "instrumentation");
if (existsSync(instrumentationManifestDir)) {
  copyDereferenced(instrumentationManifestDir, path.join(outDir, ".next", "server", "instrumentation"));
}
step("Copying .next/server/chunks/ in full (instrumentation.js's own chunk deps aren't traced either)");
const serverChunksSrc = path.join(root, ".next", "server", "chunks");
if (existsSync(serverChunksSrc)) {
  copyDereferenced(serverChunksSrc, path.join(outDir, ".next", "server", "chunks"));
}

// --- 2b. Backfill Next's own nested runtime dependencies ---
//
// https://github.com/joshuatownsend/project-minder/issues/287 — `next
// build`'s own `.next/standalone` tracer output flattens each
// `serverExternalPackages` entry (next itself, better-sqlite3, ...) to
// a single top-level `node_modules/<pkg>` directory, discarding pnpm's
// per-package isolated node_modules structure along the way — so any
// *nested* runtime dependency that package resolves via a pnpm sibling
// symlink (rather than a static import Next's tracer can see) goes
// missing. Observed in practice: `next` needs @next/env, @swc/helpers,
// baseline-browser-mapping, caniuse-lite, postcss, styled-jsx (and
// their own transitive deps); `better-sqlite3` needs `bindings`. Both
// fail at boot/first-use with MODULE_NOT_FOUND on any machine that
// doesn't also happen to have this project's pnpm store on disk —
// defeating the entire point of a "movable" standalone package.
//
// Rather than hardcode that gap list (one Next/dependency upgrade away
// from being wrong), this discovers whatever packages Next's tracer
// already placed at the top level of dist's node_modules — today
// next, better-sqlite3, react, react-dom, web-push, but this adapts
// automatically if that set changes — and walks the REAL runtime
// dependency closure from each one's own package.json `dependencies`
// field, recursing into each dependency's own `dependencies`.
//
// Each dependency is resolved starting from the directory of the
// package that DECLARES it (not a single global root): pnpm's
// isolated store means a transitive dependency like `bindings` is
// only a sibling of the package that actually depends on it
// (node_modules/.pnpm/better-sqlite3@.../node_modules/{better-sqlite3,
// bindings}), not of the repo root. Resolving from a fixed root
// instead risks Node's ordinary upward directory search falling
// through past the intended package entirely and picking up an
// unrelated, potentially version-mismatched copy from an ancestor
// directory (confirmed empirically in this worktree: resolving
// "bindings" from the repo root falls through to a stray top-level
// copy in the parent checkout one directory up, while resolving it
// from better-sqlite3's own resolved directory correctly finds the
// worktree's real, pnpm-isolated copy).
//
// `sharp` (next's only optionalDependency besides the
// platform-specific SWC compiler binaries, which are build-time-only
// and correctly absent from standalone output) is walked too, but on
// a best-effort basis: warn, don't fail, if it's absent — only
// image-optimization routes that actually decode images at request
// time would be affected.
step("Verifying externalized packages' nested runtime dependencies resolve inside dist");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function resolvePackageDir(name, fromDir) {
  const pkgJsonPath = require_.resolve(path.join(name, "package.json"), {
    paths: [fromDir],
  });
  return path.dirname(pkgJsonPath);
}

// Top-level entries already in dist's node_modules right now (before
// any backfill) — the packages Next's tracer chose to externalize.
// Scoped packages (@scope/name) live one directory deeper.
function listTopLevelPackages(nodeModulesDir) {
  const names = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith(".")) continue; // .bin, .package-lock.json, etc.
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(path.join(nodeModulesDir, entry))) {
        names.push(`${entry}/${scoped}`);
      }
    } else {
      names.push(entry);
    }
  }
  return names;
}

// BFS over `dependencies` fields (not peerDependencies/devDependencies).
// Each root name is resolved from `root` (the repo's own node_modules —
// correct for these, since they're all direct/optional dependencies of
// the repo's package.json and so are symlinked at the top level);
// everything discovered from there on is resolved from the directory
// of whichever package declared it, cascading down the real dependency
// graph the same way Node's own resolution would at runtime.
function walkDependencyClosure(rootNames, { optional = false } = {}) {
  const closure = new Map(); // name -> real package dir
  const queue = rootNames.map((name) => ({ name, fromDir: root }));
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (closure.has(name)) continue;
    let pkgDir;
    try {
      pkgDir = resolvePackageDir(name, fromDir);
    } catch (err) {
      console.warn(
        `[package-standalone] WARNING: could not resolve ${optional ? "optional" : "required"} ` +
          `dependency "${name}" from the repo's node_modules (${String(err.message).split("\n")[0]}) — skipping.`
      );
      continue;
    }
    closure.set(name, pkgDir);
    const pkgJson = readJson(path.join(pkgDir, "package.json"));
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if (!closure.has(dep)) queue.push({ name: dep, fromDir: pkgDir });
    }
  }
  return closure;
}

// Does `name` already have a package.json somewhere Node's resolution
// would find it from inside dist — nested under any already-packaged
// top-level dependency's own node_modules, or at outDir's top level
// (Node's resolution algorithm checks every ancestor node_modules, and
// outDir/node_modules is always one of them no matter how deep inside
// outDir/node_modules the requiring file lives)?
//
// Deliberately a plain existsSync check, not require_.resolve: Node
// caches negative module-resolution lookups internally
// (Module._pathCache), so re-querying the same (request, paths) pair
// after a file appears mid-process — exactly what happens here, since
// this same function is called once before backfilling (to decide
// whether to skip a package) and once after (the tripwire) — can keep
// returning the pre-copy "not found" answer even though the file now
// exists. A real `node server.js` invocation is a fresh process with
// an empty cache and would resolve it correctly; existsSync sidesteps
// the footgun entirely rather than relying on that distinction.
function resolvesInsideDist(name) {
  if (existsSync(path.join(outDir, "node_modules", name, "package.json"))) return true;
  for (const topLevel of listTopLevelPackages(path.join(outDir, "node_modules"))) {
    if (existsSync(path.join(outDir, "node_modules", topLevel, "node_modules", name, "package.json"))) {
      return true;
    }
  }
  return false;
}

const initialTopLevelPackages = listTopLevelPackages(path.join(outDir, "node_modules"));
const requiredClosure = walkDependencyClosure(initialTopLevelPackages);
const optionalClosure = walkDependencyClosure(["sharp"], { optional: true });

let backfilledCount = 0;
for (const [name, srcDir] of [...requiredClosure, ...optionalClosure]) {
  if (resolvesInsideDist(name)) continue;
  step(`Backfilling missing nested dependency: ${name}`);
  copyDereferenced(srcDir, path.join(outDir, "node_modules", name));
  backfilledCount += 1;
}

if (backfilledCount > 0) {
  step(
    `Backfilled ${backfilledCount} package(s) Next's tracer omitted from ` +
      `.next/standalone (see issue #287)`
  );
} else {
  step("All externalized packages' nested runtime dependencies already resolve inside dist");
}

// Tripwire: fail the packaging run rather than silently ship a bundle
// that will MODULE_NOT_FOUND at boot (or first use) on a machine
// without this repo's node_modules. Catches both a backfill that
// still didn't land (it always should, having just been copied from a
// location we resolved successfully) and a required dependency that
// failed to resolve from the repo itself in the first place (never
// entered `requiredClosure`, so no backfill was attempted) — e.g. a
// future Next/dependency upgrade renaming or dropping a package in a
// way this script doesn't yet know how to find.
const unresolved = [...requiredClosure.keys()].filter((name) => !resolvesInsideDist(name));
if (unresolved.length > 0) {
  fail(
    `The following required Next runtime dependencies do not resolve inside ` +
      `${path.relative(root, outDir)} after backfill: ${unresolved.join(", ")}. ` +
      `This package would fail to boot with MODULE_NOT_FOUND on a machine without ` +
      `this repo's node_modules. See issue #287 for background.`
  );
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

// --- 3b. schema.sql for the worker's schema lookup ---
//
// `resolveSchemaPath()` (src/lib/db/migrations.ts) first tries a path
// sibling to the compiled migrations module (found automatically for
// the in-process/main-thread path, since Next's file tracer can see
// that statically-shaped readFileSync call and copies schema.sql next
// to it), then falls back to MINDER_SERVER_ROOT (set by the server.js
// wrapper, below) or process.cwd() — walking up looking for
// `src/lib/db/schema.sql`. The worker bundle (workers/dist/
// ingestWorker.mjs, built by esbuild, not traced by Next) has its
// __dirname pinned to workers/dist/ — schema.sql is never there — so
// it always falls through to that anchor-walk. On a machine that only
// has dist/minder-server/ (no repo checkout), it finds nothing unless
// we plant schema.sql at the first path it checks: <anchor>/src/lib/
// db/schema.sql. MINDER_SERVER_ROOT is outDir itself, so copying
// schema.sql to outDir/src/lib/db/schema.sql lands exactly there
// regardless of the caller's actual cwd.
step("Copying src/lib/db/schema.sql (worker's schema.sql lookup fallback)");
const schemaSrcPath = path.join(root, "src", "lib", "db", "schema.sql");
if (existsSync(schemaSrcPath)) {
  const schemaDestPath = path.join(outDir, "src", "lib", "db", "schema.sql");
  mkdirSync(path.dirname(schemaDestPath), { recursive: true });
  copyFileSync(schemaSrcPath, schemaDestPath);
} else {
  console.warn(
    `[package-standalone] WARNING: ${path.relative(root, schemaSrcPath)} not found — ` +
      `MINDER_INDEXER_WORKER=1 will fail with "schema.sql not found" against this package.`
  );
}

// --- 3c. chokidar for the worker's file-watching ---
//
// build-worker.mjs's esbuild config externalizes `better-sqlite3` and
// `chokidar` from the worker bundle (both ship native/platform-
// specific bits) so the worker resolves them from node_modules at
// runtime, same as the main thread. better-sqlite3 is already covered
// by the closure-walk backfill above (it's one of Next's own
// externalized top-level packages), but chokidar is used ONLY by this
// esbuild-bundled worker — nothing in Next's traced route graph
// imports it, so it's never a candidate for that backfill and Next's
// tracer has no way to know it's needed. Without it, the worker
// doesn't crash — chokidar's own dynamic import fails gracefully and
// the watcher falls back to sweep-only mode — but that's a silent
// functionality downgrade (no live file-watching, periodic full
// sweeps only) that's easy to miss since nothing errors loudly.
step("Copying chokidar (worker's file-watching dependency, externalized from the esbuild bundle)");
if (resolvesInsideDist("chokidar")) {
  step("chokidar already resolves inside dist, skipping");
} else {
  try {
    const chokidarDir = resolvePackageDir("chokidar", root);
    copyDereferenced(chokidarDir, path.join(outDir, "node_modules", "chokidar"));
  } catch (err) {
    console.warn(
      `[package-standalone] WARNING: could not resolve chokidar from the repo's node_modules ` +
        `(${String(err.message).split("\n")[0]}) — MINDER_INDEXER_WORKER=1 will fall back to ` +
        `sweep-only mode (no live file-watching) against this package.`
    );
  }
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
  // Array#some coerces its callback's return value to boolean, so a
  // clause returning `null` (unrecognized shape) is just treated as
  // falsy — there's no way to tell "every clause was unrecognized"
  // apart from "every clause failed to match" using .some() alone.
  // Track recognition separately so an all-unrecognized range can
  // still produce the intended null (warn-and-proceed) result.
  let recognized = false;
  const matched = clauses.some((clause) => {
    const caret = clause.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    if (caret) {
      recognized = true;
      const [, cMajor, cMinor, cPatch] = caret.map(Number);
      if (major !== cMajor) return false;
      if (minor > cMinor) return true;
      if (minor < cMinor) return false;
      return patch >= cPatch;
    }
    const gte = clause.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
    if (gte) {
      recognized = true;
      const [, gMajor, gMinor, gPatch] = gte.map(Number);
      if (major !== gMajor) return major > gMajor;
      if (minor !== gMinor) return minor > gMinor;
      return patch >= gPatch;
    }
    return false; // unrecognized clause shape — doesn't count as a match
  });
  return recognized ? matched : null;
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
    "uses Node 20 and 22, which do NOT share a NODE_MODULE_VERSION (Node 20 = ABI " +
    "115, Node 22 = ABI 127) — verify with `node -p process.versions.modules` on " +
    "both the build machine and the runtime host before deploying across a Node " +
    "major boundary. A mismatch surfaces as \"was compiled against a different " +
    "Node.js version\" the first time an OTel or DB-backed route touches " +
    "better-sqlite3.",
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
const path = require("node:path");

// Anchor MINDER_SERVER_ROOT to this package's own directory (__dirname
// is CJS-native here — this file is never bundled, it's written fresh
// by the packaging script). Without this, code that resolves paths
// relative to process.cwd() (workerHost.ts's default ingest-worker
// entry, migrations.ts's resolveSchemaPath cwd-walk fallback) breaks
// the moment this package is launched by absolute path from some other
// directory — found nothing (or, launched from a repo checkout,
// silently loaded that repo's SOURCE files instead of this package's
// own) (PR #285 review, Codex P2). Doesn't override an operator's own
// explicit value.
if (!process.env.MINDER_SERVER_ROOT) {
  process.env.MINDER_SERVER_ROOT = __dirname;
}

// Startup ABI check: better-sqlite3's prebuilt .node binary is tied to the
// NODE_MODULE_VERSION it was compiled against (see BUILD_INFO.json). Running
// this package under a mismatched Node major fails opaquely deep inside the
// first DB-backed request; this check fails loudly at boot instead.
const fs = require("node:fs");

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
  const message = err instanceof Error ? err.message : String(err);
  console.warn("[minder-server] could not read BUILD_INFO.json for the startup ABI check:", message);
}

require("./server.next.js");
`;
writeFileSync(generatedServerPath, wrapper);
step("Wrote server.js wrapper (sets MINDER_SERVER_ROOT, ABI check, delegates to server.next.js)");

// --- Summary ---
step(`Done. Package assembled at ${path.relative(root, outDir)}`);
step(`Run with: PORT=4100 HOSTNAME=127.0.0.1 node ${path.join(outDir, "server.js")}`);
