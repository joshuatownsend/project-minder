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
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isForbiddenName } from "./payload-hygiene-rules.mjs";

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
  // Never let a forbidden entry (.git, .env*, .claude, .mcp.json, sibling
  // repos — see payload-hygiene-rules.mjs) materialize in the payload, at any
  // depth. Next's tracer has over-traced repo-root files into
  // `.next/standalone` before (issue #284), which shipped a real `.git` and
  // `.env.local` into dist; pruning here — at the only boundary everything
  // must cross — is the cure, and CI's verify-payload-hygiene.mjs gate stays
  // as the independent backstop.
  if (isForbiddenName(path.basename(src))) {
    step(`  pruned forbidden entry: ${path.relative(root, src)}`);
    return;
  }
  let real;
  let stat;
  try {
    real = realpathSync(src);
    stat = statSync(src); // follows symlinks/junctions
  } catch (err) {
    // Next's standalone output preserves pnpm's `.pnpm/node_modules` hoist-dir
    // symlinks even when it didn't trace (and therefore didn't copy) their
    // targets, so on Linux/macOS the walk meets genuinely dangling links
    // (e.g. `.pnpm/node_modules/semver`). A link that dangles at build time
    // can't have resolved at runtime either — and every package the server
    // actually needs is staged by the dependency-closure backfill below — so
    // skip it rather than abort. Anything else missing is a real error.
    if (
      err.code === "ENOENT" &&
      lstatSync(src, { throwIfNoEntry: false })?.isSymbolicLink()
    ) {
      step(`  skipped dangling symlink: ${path.relative(root, src)}`);
      return;
    }
    throw err;
  }
  if (ancestry.has(real)) {
    // A symlink cycle (pnpm store self-reference) — skip re-descending
    // rather than recursing forever. Not expected in practice, but
    // cheap to guard against in a build script.
    return;
  }
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

// BFS over `dependencies` fields (not peerDependencies/devDependencies),
// preserving VERSION identity along every edge rather than collapsing to
// one dir per name. pnpm already resolved the correct version for each
// requester (an isolated per-package node_modules), so the dir we resolve
// each dependency from — starting at its declaring parent's own dir — IS
// that requester's correct version. Recording (parent -> dep@version)
// edges instead of a name->dir map is what lets the placement pass below
// honour two packages that legitimately need different majors of the same
// dependency (e.g. the app's zod 3 vs. claude-code-lint's zod 4).
//
// Each root name is resolved from `seedDir` (default `root`, the repo's
// own node_modules — correct for the top-level roots, since they're all
// direct/optional dependencies of the repo's package.json and so are
// symlinked at the top level; the .pnpm store-path walk below passes the
// real store node_modules of the package it's expanding instead) with
// `parentName === null`: roots ARE the base. Everything discovered from
// there on is resolved from the directory of whichever package declared
// it, cascading down the real dependency graph the same way Node's own
// resolution would at runtime.
//
// `visited` is keyed by resolved dir, not name — it only guards against
// re-walking a package's own dependencies (and symlink cycles). A given
// (name, version) has exactly one dir, so distinct versions are distinct
// dirs and both get walked; and edges are recorded BEFORE the visited
// check, so every requester of a shared package still produces its edge.
function walkDependencyClosure(rootNames, { optional = false, seedDir = root } = {}) {
  const edges = []; // { name, dir, version, parentName }
  const visited = new Set(); // resolved dirs whose deps are already queued
  const queue = rootNames.map((name) => ({ name, fromDir: seedDir, parentName: null }));
  while (queue.length > 0) {
    const { name, fromDir, parentName } = queue.shift();
    let pkgDir;
    try {
      pkgDir = resolvePackageDir(name, fromDir);
    } catch (err) {
      console.warn(
        `[package-standalone] WARNING: could not resolve ${optional ? "optional" : "required"} ` +
          `dependency "${name}"${parentName ? ` (declared by ${parentName})` : " from the repo's node_modules"} ` +
          `(${String(err.message).split("\n")[0]}) — skipping.`
      );
      continue;
    }
    const pkgJson = readJson(path.join(pkgDir, "package.json"));
    const version = pkgJson.version ?? "0.0.0-unknown";
    edges.push({ name, dir: pkgDir, version, parentName });
    if (visited.has(pkgDir)) continue;
    visited.add(pkgDir);
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: pkgDir, parentName: name });
    }
  }
  return edges;
}

// Read a package.json's `version`, or null if unreadable.
//
// existsSync + read, deliberately NOT require_.resolve: Node caches
// negative module-resolution lookups internally (Module._pathCache), so
// re-querying a (request, paths) pair after a file appears mid-process —
// exactly what happens here, since these checks run before and after
// copying files in — can keep returning the pre-copy "not found" answer
// even though the file now exists. A real `node server.js` invocation is
// a fresh process with an empty cache and resolves correctly; existsSync
// sidesteps the footgun rather than relying on that distinction.
function readPkgVersion(pkgJsonPath) {
  try {
    return readJson(pkgJsonPath).version ?? null;
  } catch {
    return null;
  }
}

// Version occupying dist's TOP-LEVEL node_modules/<name> slot right now,
// or null if empty. A non-null answer is the app's own copy (placed by
// Next's tracer or a prior placement pass) and is authoritative for the
// top level — never overwritten.
function topLevelPkgVersion(name) {
  const p = path.join(outDir, "node_modules", name, "package.json");
  return existsSync(p) ? readPkgVersion(p) : null;
}

// Simulate Node's resolution for a (parent -> dep) edge inside dist:
// check the parent's own nested node_modules first (Node checks the
// nearest node_modules before walking up), then the top level. Returns
// the version Node would load, or null if it resolves to neither. Mirrors
// exactly the two levels the placement pass writes to.
function distResolvedVersion(parentName, depName) {
  if (parentName) {
    const nested = path.join(outDir, "node_modules", parentName, "node_modules", depName, "package.json");
    if (existsSync(nested)) return readPkgVersion(nested);
  }
  const top = path.join(outDir, "node_modules", depName, "package.json");
  return existsSync(top) ? readPkgVersion(top) : null;
}

// Place a set of dependency-closure edges into dist so every requester
// resolves the exact version it declared:
//   Pass 1 fills each EMPTY top-level slot with one version (the one the
//     most edges want; ties broken by first-encountered, which Map
//     insertion order preserves). An occupied slot is never touched —
//     that's the app's own version, placed by Next's tracer.
//   Pass 2 copies any requester whose declared version differs from the
//     top-level occupant into `<parent>/node_modules/<dep>`, where Node
//     finds it before walking up to the (different) top-level copy — so
//     nesting wins for that requester without disturbing anyone else.
// Returns the number of package copies made.
function placeClosureEdges(edges) {
  const versionsByName = new Map(); // name -> Map<version, { dir, count }>
  for (const e of edges) {
    let byVersion = versionsByName.get(e.name);
    if (!byVersion) versionsByName.set(e.name, (byVersion = new Map()));
    const seen = byVersion.get(e.version);
    if (seen) seen.count += 1;
    else byVersion.set(e.version, { dir: e.dir, count: 1 });
  }

  let copied = 0;

  for (const [name, byVersion] of versionsByName) {
    if (topLevelPkgVersion(name) !== null) continue; // app's copy stays
    let best = null;
    for (const [version, info] of byVersion) {
      if (!best || info.count > best.info.count) best = { version, info };
    }
    step(`Backfilling top-level dependency: ${name}@${best.version}`);
    copyDereferenced(best.info.dir, path.join(outDir, "node_modules", name));
    copied += 1;
  }

  for (const e of edges) {
    if (!e.parentName) continue; // root edges are served by the top level
    const occupant = topLevelPkgVersion(e.name);
    if (occupant === e.version) continue; // top level already serves this edge
    const destDir = path.join(outDir, "node_modules", e.parentName, "node_modules", e.name);
    const destPkgJson = path.join(destDir, "package.json");
    if (existsSync(destPkgJson) && readPkgVersion(destPkgJson) === e.version) continue; // already nested
    step(`Nesting ${e.name}@${e.version} under ${e.parentName} (top level has ${occupant ?? "no copy"})`);
    copyDereferenced(e.dir, destDir);
    copied += 1;
  }

  return copied;
}

// Version-aware tripwire: every edge must resolve, inside dist, to the
// exact version it resolved to in the repo. Returns human-readable
// descriptions of the edges that don't (empty === all good).
function unresolvedEdges(edges) {
  const failures = [];
  for (const e of edges) {
    const got = distResolvedVersion(e.parentName, e.name);
    if (got !== e.version) {
      failures.push(
        `${e.parentName ? `${e.parentName} -> ` : ""}${e.name}@${e.version} (dist resolves ${got ?? "MISSING"})`
      );
    }
  }
  return failures;
}

const initialTopLevelPackages = listTopLevelPackages(path.join(outDir, "node_modules"));
const requiredEdges = walkDependencyClosure(initialTopLevelPackages);
const optionalEdges = walkDependencyClosure(["sharp"], { optional: true });

const backfilledCount = placeClosureEdges([...requiredEdges, ...optionalEdges]);

if (backfilledCount > 0) {
  step(
    `Backfilled ${backfilledCount} package copy/copies Next's tracer omitted from ` +
      `.next/standalone (see issue #287)`
  );
} else {
  step("All externalized packages' nested runtime dependencies already resolve inside dist");
}

// Tripwire: fail the packaging run rather than silently ship a bundle
// that will MODULE_NOT_FOUND — or, worse, resolve the WRONG major — at
// boot (or first use) on a machine without this repo's node_modules.
// Catches a required dependency that failed to resolve from the repo
// itself (never produced an edge, so no backfill was attempted) as well
// as any edge whose version the packaged layout doesn't actually serve —
// e.g. a future Next/dependency upgrade renaming or dropping a package,
// or a version conflict the placement pass couldn't satisfy. Required
// edges are hard failures; `sharp` is optional (only image-optimization
// routes that decode at request time need it), so its unresolved edges
// warn instead.
const requiredFailures = unresolvedEdges(requiredEdges);
if (requiredFailures.length > 0) {
  fail(
    `These required Next runtime dependency edges do not resolve to their expected ` +
      `version inside ${path.relative(root, outDir)} after backfill:\n  ` +
      requiredFailures.join("\n  ") +
      `\nThis package would fail (or load the wrong version) on a machine without this ` +
      `repo's node_modules. See issue #287 for background.`
  );
}
const optionalFailures = unresolvedEdges(optionalEdges);
if (optionalFailures.length > 0) {
  console.warn(
    `[package-standalone] WARNING: optional dependency edges unresolved inside dist ` +
      `(image optimization may be degraded): ${optionalFailures.join(", ")}`
  );
}

// --- 2c. Backfill .pnpm store-path packages' dependency subtrees ---
//
// The top-level closure walk above only reaches packages Next's tracer
// emitted at dist's TOP-LEVEL node_modules. Some externalized packages are
// kept at their pnpm store path instead — `node_modules/.pnpm/<key>/
// node_modules/<pkg>` — and never surface as a top-level root. For a
// package whose deps Next resolves via a static import it can follow, the
// tracer preserves the sibling deps alongside it in that store path
// (verified: better-sqlite3, web-push, sharp, next all keep theirs). But
// `claude-code-lint` (a serverExternalPackage) is spawned as a CLI child
// process — the app only `require.resolve`s its package.json and then execs
// its `bin`, so its own `require("zod")`/`require("chalk")`/... happen at
// runtime in a shape Next's static tracer can't see. The tracer copies ONLY
// the package dir into `.pnpm/claude-code-lint@.../node_modules/`, dropping
// EVERY dependency sibling — so the spawned CLI would resolve `zod` by
// escaping upward out of the bundle (finding the app's zod 3, the WRONG
// major) or MODULE_NOT_FOUND on a machine with only dist/.
//
// pnpm makes such a subtree resolve through symlinks + realpath: each store
// package's node_modules holds symlinks to the EXACT versions of its own
// deps. We copy dereferenced (real dirs, for portability), which can't rely
// on realpath, so we instead re-materialise the subtree in the npm layout
// Node's plain walk-up resolves: hoist each dependency to the subtree root
// when that slot is free, and nest it directly under the requiring package
// only when the root already holds a different version. This is what makes
// a subtree with several majors of one package correct — claude-code-lint
// pulls chalk 4 and 5, ora 5 and 9, cli-cursor 3 and 5, ... Every version
// comes from the repo's real dirs, preserving pnpm's exact resolution.
step("Verifying .pnpm store-path packages' dependency subtrees resolve inside dist");

// Version present at <nmDir>/<name>/package.json, or null.
function pkgVersionAt(nmDir, name) {
  const p = path.join(nmDir, name, "package.json");
  return existsSync(p) ? readPkgVersion(p) : null;
}

const distNmDir = path.join(outDir, "node_modules");
const pnpmStoreDir = path.join(distNmDir, ".pnpm");
// The `.pnpm/node_modules` hoist dir and dist's top level both sit on
// Node's real walk-up path from any store-path package, so a dep already
// present there resolves — order matches the walk (hoist dir is nearer).
const storeFallbacks = [path.join(pnpmStoreDir, "node_modules"), distNmDir].filter((d) =>
  existsSync(d)
);
let storeBackfilled = 0;
const storeTripwireFailures = [];
const storeBackfillReport = []; // `<key> :: <dep>@<version> @ <relative dest>`

// Place `pkgName`'s runtime dependencies (and, recursively, theirs) into a
// store subtree rooted at `rootNm`. `resolveNms` is the ordered list of
// node_modules dirs visible to `pkgName` — its own first, each ancestor up
// to `rootNm`, then the shared `fallbacks` (hoist dir + dist top level).
// `recursed` guards against re-descending a package (and dependency cycles);
// `failures` collects any edge that still mis-resolves after placement.
function placeStoreSubtree(pkgName, pkgRepoDir, resolveNms, rootNm, storeKey, fallbacks, recursed, failures) {
  let pkgJson;
  try {
    pkgJson = readJson(path.join(pkgRepoDir, "package.json"));
  } catch {
    return;
  }
  for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
    let depRepoDir;
    try {
      depRepoDir = resolvePackageDir(depName, pkgRepoDir);
    } catch (err) {
      console.warn(
        `[package-standalone] WARNING: could not resolve "${depName}" declared by ${pkgName} ` +
          `for the .pnpm/${storeKey} store subtree (${String(err.message).split("\n")[0]}) — skipping.`
      );
      continue;
    }
    const depVersion = readJson(path.join(depRepoDir, "package.json")).version ?? "0.0.0-unknown";

    // Where, if anywhere, does depName already resolve for this requirer?
    let found = null;
    for (const nm of resolveNms) {
      const v = pkgVersionAt(nm, depName);
      if (v !== null) { found = v; break; }
    }

    let destNm; // node_modules dir to place into, or null if already correct
    if (found === depVersion) destNm = null;
    else if (found === null) destNm = rootNm;      // unseen up-chain → hoist to subtree root
    else destNm = resolveNms[0];                    // seen at another version → nest under requirer

    if (destNm) {
      const destDir = path.join(destNm, depName);
      const destPkgJson = path.join(destDir, "package.json");
      if (!(existsSync(destPkgJson) && readPkgVersion(destPkgJson) === depVersion)) {
        const rel = path.relative(distNmDir, destDir).split(path.sep).join("/");
        step(`Store backfill: ${depName}@${depVersion} -> ${rel}`);
        copyDereferenced(depRepoDir, destDir);
        storeBackfilled += 1;
        storeBackfillReport.push(`${storeKey} :: ${depName}@${depVersion} @ ${rel}`);
      }
    }

    // Independent tripwire: confirm the edge now resolves to its version.
    let got = null;
    for (const nm of resolveNms) {
      const v = pkgVersionAt(nm, depName);
      if (v !== null) { got = v; break; }
    }
    if (got !== depVersion) {
      failures.push(`.pnpm/${storeKey}: ${pkgName} -> ${depName}@${depVersion} (dist resolves ${got ?? "MISSING"})`);
    }

    // Recurse into the dependency's own subtree once — only when we placed
    // it (reused copies were already descended when first placed; fallback
    // copies belong to the top-level backfill's closure, not this subtree).
    if (destNm) {
      const depDir = path.join(destNm, depName);
      if (!recursed.has(depDir)) {
        recursed.add(depDir);
        const depSelfNm = path.join(depDir, "node_modules");
        const depResolveNms =
          destNm === rootNm
            ? [depSelfNm, rootNm, ...fallbacks]     // hoisted: dep sits at the subtree root
            : [depSelfNm, ...resolveNms];           // nested: dep sits inside the requirer
        placeStoreSubtree(depName, depRepoDir, depResolveNms, rootNm, storeKey, fallbacks, recursed, failures);
      }
    }
  }
}

if (existsSync(pnpmStoreDir)) {
  for (const storeKey of readdirSync(pnpmStoreDir)) {
    if (storeKey.startsWith(".")) continue; // .bin etc.
    if (storeKey === "node_modules") continue; // the hoist dir, not a store entry
    const storeNmDir = path.join(pnpmStoreDir, storeKey, "node_modules");
    const repoStoreNmDir = path.join(root, "node_modules", ".pnpm", storeKey, "node_modules");
    // Can't resolve real dep versions without the repo's matching store path.
    if (!existsSync(storeNmDir) || !existsSync(repoStoreNmDir)) continue;

    const recursed = new Set();
    // The package(s) the tracer emitted into this store path are the roots.
    for (const rootPkg of listTopLevelPackages(storeNmDir)) {
      let rootRepoDir;
      try {
        rootRepoDir = resolvePackageDir(rootPkg, repoStoreNmDir);
      } catch {
        continue;
      }
      const rootSelfNm = path.join(storeNmDir, rootPkg, "node_modules");
      placeStoreSubtree(
        rootPkg,
        rootRepoDir,
        [rootSelfNm, storeNmDir, ...storeFallbacks],
        storeNmDir,
        storeKey,
        storeFallbacks,
        recursed,
        storeTripwireFailures,
      );
    }
  }
}

if (storeBackfilled > 0) {
  step(
    `Backfilled ${storeBackfilled} .pnpm store-path dependency copy/copies the tracer emitted ` +
      `a package without`
  );
} else {
  step("All .pnpm store-path packages' dependency subtrees already resolve inside dist");
}
if (storeTripwireFailures.length > 0) {
  fail(
    `These .pnpm store-path dependency edges do not resolve to their expected version inside ` +
      `${path.relative(root, outDir)} after backfill:\n  ` +
      storeTripwireFailures.join("\n  ") +
      `\nThe corresponding packaged tool would MODULE_NOT_FOUND (or load the wrong version) at runtime.`
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
// Copied via the same walkDependencyClosure as the Next backfill above —
// NOT a single-directory copy — because pnpm's isolated store keeps
// chokidar's own `dependencies` (readdirp, in this lockfile) as siblings
// of the real package dir, which a lone copy would leave behind and the
// packaged worker would MODULE_NOT_FOUND at watch time (PR #285 review).
step("Copying chokidar + its dependency closure (worker's file-watching, externalized from the esbuild bundle)");
const chokidarEdges = walkDependencyClosure(["chokidar"], { optional: true });
const chokidarCopied = placeClosureEdges(chokidarEdges);
if (chokidarEdges.length === 0) {
  console.warn(
    `[package-standalone] WARNING: could not resolve chokidar from the repo's node_modules — ` +
      `MINDER_INDEXER_WORKER=1 will fall back to sweep-only mode (no live file-watching) ` +
      `against this package.`
  );
} else {
  const unresolvedWatch = unresolvedEdges(chokidarEdges);
  if (unresolvedWatch.length > 0) {
    fail(
      `chokidar's dependency closure does not fully resolve inside ` +
        `${path.relative(root, outDir)} after backfill: ${unresolvedWatch.join(", ")}. ` +
        `The packaged worker's file-watching would MODULE_NOT_FOUND at runtime.`
    );
  }
  step(
    chokidarCopied > 0
      ? `Backfilled ${chokidarCopied} file-watching package copy/copies (chokidar closure)`
      : "chokidar closure already resolves inside dist, skipping"
  );
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

// Prove the COPIED binary's ABI matches this packaging process (PR #285
// review, Codex P2): BUILD_INFO.json records process.versions.modules of
// whatever Node runs this script — but if the repo's node_modules was
// built under a DIFFERENT Node major (switched 20↔22 without a rebuild,
// stale CI cache), the copied .node file's real ABI diverges from that
// record, the generated startup check stays silent, and the first
// DB-backed route crashes at require() time. Actually dlopen-ing the
// packaged file is the only authoritative check: if it loads under this
// process, its ABI IS this process's ABI, so the value written below is
// truthful by construction. (dlopen rather than require("better-sqlite3")
// so we test the exact copied artifact, not whatever module resolution
// might find; better_sqlite3.node has no load-time side effects beyond
// registering its exports.)
try {
  process.dlopen({ exports: {} }, realpathSync(packagedSqliteNode));
  step("Verified packaged better_sqlite3.node loads under this Node (ABI matches BUILD_INFO)");
} catch (err) {
  fail(
    `Packaged better_sqlite3.node failed to load under the packaging Node ` +
      `(${process.version}, ABI ${process.versions.modules}): ` +
      `${String(err && err.message).split("\n")[0]}. The repo's node_modules was likely ` +
      `built under a different Node major — run "pnpm rebuild better-sqlite3" (or a full ` +
      `"pnpm install") with the same Node you package with, then re-run packaging.`
  );
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
