// Local release build for the Project Minder tray app (plan task R1).
//
// Reproduces, on a developer machine, the exact chain that
// .github/workflows/release-installers.yml runs in CI:
//
//   1. pnpm build                             -> .next (prebuild hook runs build:worker)
//   2. pnpm package:standalone                -> dist/minder-server (the Node sidecar payload)
//   3. node scripts/verify-payload-hygiene.mjs -> fails if .git/.env*/.claude/... leaked (#284)
//   4. node scripts/fetch-node-runtime.mjs    -> dist/node (SHA-256 verified from nodejs.org)
//   5. pnpm tauri build --bundles <targets>   -> installers under src-tauri/target/release/bundle
//
// Before step 5 it STAMPS the real version from package.json into
// src-tauri/tauri.conf.json, exactly as the CI "Stamp app version" step does,
// then restores the file afterwards (see restoreOnExit for why).
//
// What the stamp is still for: tauri.conf.json's `version` is the path
// "../package.json", which Tauri resolves itself, so the built version is
// already correct without stamping. The rewrite pins that to a literal anyway
// (matching CI byte-for-byte) and — the part that is genuinely load-bearing —
// is the same edit that switches createUpdaterArtifacts off when there is no
// signing key. Before the path form landed the field was a hardcoded "0.1.0",
// and an unstamped build shipped an installer that reported 0.1.0 forever;
// under the auto-updater every such install would consider itself ancient,
// download the current release, still report 0.1.0, and update-loop forever.
//
// Usage:
//   pnpm release:local                       # host OS's natural bundles
//   pnpm release:local --bundles nsis        # explicit target list
//   pnpm release:local --skip-build          # reuse .next + dist/minder-server
//   pnpm release:local --skip-node           # reuse dist/node (the ~80 MB fetch)
//   pnpm release:local --dry-run             # print the plan, run nothing
//
// Pure decision logic lives in scripts/release/lib.mjs (same split as
// service.mjs + service/lib.mjs) and is unit-tested in tests/releaseLocal.test.ts.
//
// This script never uploads anything and never touches a GitHub Release —
// publishing stays the tag-push workflow's job.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  defaultBundles,
  checkVersionConsistency,
  selectReleaseTag,
  stampVersionInConf,
  canSignUpdaterArtifacts,
  formatSize,
  buildPlan,
} from "./release/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const isWindows = process.platform === "win32";
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");

function log(message) {
  console.log(`[release-local] ${message}`);
}
function fail(message) {
  console.error(`[release-local] ERROR: ${message}`);
  process.exit(1);
}

function printUsage() {
  console.log(
    [
      "Usage: pnpm release:local [options]",
      "",
      "  --bundles <list>  Comma-separated Tauri bundle targets (default: host OS's natural set)",
      "  --skip-build      Reuse existing .next and dist/minder-server",
      "  --skip-node       Reuse existing dist/node instead of re-downloading (~80 MB)",
      "  --dry-run         Print the plan and exit without running anything",
      "  -h, --help        Show this message",
    ].join("\n")
  );
}

// ---------------------------------------------------------------- version

/**
 * The version every artifact must carry: package.json is the single source of
 * truth, matching CI (release.yml's chore(release) bumps it and the tag follows).
 */
function readPackageVersion() {
  const pkgPath = path.join(root, "package.json");
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (typeof version !== "string" || !version) {
    fail(`package.json has no usable "version" field`);
  }
  return version;
}

/** The `v*` tag pointing at HEAD, or null if HEAD isn't tagged. */
function tagAtHead() {
  const result = spawnSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return selectReleaseTag(result.stdout);
}

/**
 * Stamp `version` into tauri.conf.json and return a restore function.
 *
 * We rewrite the workspace file rather than passing `tauri build --config`,
 * because that is precisely what CI does — and the whole point of this script is
 * that a local build and a CI build produce the same bytes.
 *
 * Restoring matters more locally than it does in CI: CI throws its checkout away,
 * but here the stamp would otherwise sit in the working tree as an unexplained
 * diff, easy to commit by accident. The restore is wired to both the normal exit
 * path and the signal handlers, because `tauri build` runs for minutes and Ctrl-C
 * during it is entirely normal.
 */
function stampTauriVersion(version) {
  const original = readFileSync(tauriConfPath, "utf8");
  // Without a signing key Tauri fails the build outright rather than skipping
  // the updater artifacts, so this must be decided BEFORE the build, not
  // recovered from afterwards.
  const signable = canSignUpdaterArtifacts();
  const { text, previous } = stampVersionInConf(original, version, {
    updaterArtifacts: signable,
  });
  writeFileSync(tauriConfPath, text);
  log(`stamped tauri.conf.json version ${previous} -> ${version}`);
  if (signable) {
    log("TAURI_SIGNING_PRIVATE_KEY is set — building signed updater artifacts");
  } else {
    log(
      "no TAURI_SIGNING_PRIVATE_KEY — building WITHOUT updater artifacts. " +
        "The installer works, but cannot self-update. Set the env var to build a releasable one."
    );
  }

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    writeFileSync(tauriConfPath, original);
    log(`restored tauri.conf.json version to ${previous}`);
  };
}

function restoreOnExit(restore) {
  process.on("exit", restore);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      restore();
      // Conventional 128+signo exit code, so the caller's shell sees an
      // interrupted process rather than a clean exit.
      process.exit(code);
    });
  }
}

// ---------------------------------------------------------------- steps

/**
 * Run a step, inheriting stdio so the underlying tool's own output (and its
 * progress bars) reach the terminal unfiltered. Any non-zero exit aborts the
 * whole release — the CI equivalent of `set -e` plus `if-no-files-found: error`.
 */
function run(label, command, args, { shell = false } = {}) {
  log(`▶ ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`✔ ${label} (${seconds}s)`);
}

/**
 * pnpm is a .cmd shim on Windows, which Node will not spawn without shell: true
 * (EINVAL since 18.20/20.12). Every argument passed here is either a literal or
 * has been validated by the lib's BUNDLES_PATTERN, so enabling the shell
 * introduces no injection surface.
 */
function runPnpm(label, args) {
  run(label, isWindows ? "pnpm.cmd" : "pnpm", args, { shell: isWindows });
}

/**
 * Sibling node scripts are spawned with the SAME interpreter running this file,
 * not a PATH lookup — the packaging step is ABI-sensitive (better-sqlite3's
 * prebuilt .node is tied to the Node major that runs the server), so silently
 * using a different Node than the one invoking the release would be a real bug.
 */
function runNodeScript(label, scriptRelPath) {
  run(label, process.execPath, [path.join(root, scriptRelPath)]);
}

// ---------------------------------------------------------------- artifacts

const BUNDLE_ARTIFACTS = [
  ["nsis", /\.exe$/],
  ["dmg", /\.dmg$/],
  ["deb", /\.deb$/],
  ["appimage", /\.AppImage$/],
  ["macos", /\.app$/],
];

/** Total size of a .app bundle, which is a directory rather than a file. */
function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Symlinks inside .app bundles (Frameworks/Versions/Current) would be
    // double-counted or, worse, followed into a cycle — skip them outright.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : lstatSync(full).size;
  }
  return total;
}

function reportArtifacts() {
  const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
  if (!existsSync(bundleRoot)) {
    fail(`no bundle directory at ${bundleRoot} — tauri build produced nothing`);
  }

  const found = [];
  for (const [subdir, pattern] of BUNDLE_ARTIFACTS) {
    const dir = path.join(bundleRoot, subdir);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      const full = path.join(dir, name);
      const size = statSync(full).isDirectory()
        ? directorySize(full)
        : statSync(full).size;
      found.push({ full, size });
    }
  }

  // CI treats "built successfully but produced no installer" as a failure
  // (if-no-files-found: error). Same semantics here — an empty bundle dir after
  // a green build means the target list didn't match this platform.
  if (found.length === 0) {
    fail(
      `tauri build succeeded but no installers were found under ${bundleRoot}. ` +
        `Check that --bundles matches this platform.`
    );
  }

  console.log("");
  log(`installers (${found.length}):`);
  for (const { full, size } of found) {
    console.log(`  ${path.relative(root, full)}  (${formatSize(size)})`);
  }
}

// ---------------------------------------------------------------- main

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
    return;
  }

  if (opts.help) {
    printUsage();
    return;
  }

  const bundles = opts.bundles ?? defaultBundles(process.platform, process.arch);
  const version = readPackageVersion();

  const versionCheck = checkVersionConsistency(version, tagAtHead());
  if (!versionCheck.ok) fail(versionCheck.message);
  log(versionCheck.message);

  const plan = buildPlan(opts, bundles);
  log(`platform ${process.platform}/${process.arch}, bundles: ${bundles}`);
  log(`plan:\n${plan.map((s) => `    ${s}`).join("\n")}`);

  if (opts.dryRun) {
    log("dry run — nothing executed");
    return;
  }

  if (opts.skipBuild) {
    // The hygiene gate inspects dist/minder-server; with --skip-build nothing
    // creates it, so a missing payload here means "you skipped a build you
    // hadn't run yet" rather than a packaging bug. Say that plainly.
    if (!existsSync(path.join(root, "dist", "minder-server"))) {
      fail(
        "--skip-build was passed but dist/minder-server does not exist. " +
          "Run once without --skip-build first."
      );
    }
    log("skipping build + package (--skip-build)");
  } else {
    runPnpm("build Next app", ["build"]);
    runPnpm("package standalone server payload", ["package:standalone"]);
  }

  runNodeScript("payload hygiene gate", "scripts/verify-payload-hygiene.mjs");

  if (opts.skipNode) {
    if (!existsSync(path.join(root, "dist", "node"))) {
      fail(
        "--skip-node was passed but dist/node does not exist. " +
          "Run once without --skip-node first."
      );
    }
    log("skipping Node runtime fetch (--skip-node)");
  } else {
    runNodeScript("fetch pinned Node runtime", "scripts/fetch-node-runtime.mjs");
  }

  const restore = stampTauriVersion(version);
  restoreOnExit(restore);
  runPnpm("build Tauri installers", ["tauri", "build", "--bundles", bundles]);
  restore();

  reportArtifacts();
  console.log("");
  log(`done — version ${version}, unsigned.`);
}

main();
