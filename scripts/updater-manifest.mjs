// Builds the static update manifest (latest.json) the Tauri updater checks
// against (plan task U5).
//
// Two modes, because the inputs are spread across four independent matrix jobs
// and only exist together after all of them finish:
//
//   emit  — runs INSIDE each build job. Finds that job's updater artifact and
//           its detached .sig, copies the artifact into the upload dir under a
//           collision-free name, and writes a small JSON fragment carrying the
//           signature's CONTENT (not its path — a path or URL in that field is
//           the single most common way to ship a manifest no client accepts).
//
//   merge — runs in the aggregation job after all four upload. Reads every
//           fragment and emits latest.json.
//
// Usage:
//   node scripts/updater-manifest.mjs emit  --platform darwin-aarch64 --out installers
//   node scripts/updater-manifest.mjs merge --dir artifacts --repo owner/repo \
//                                           --tag v1.4.0 --out latest.json

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidPlatformKey,
  selectUpdaterSignature,
  updaterAssetName,
  buildManifest,
} from "./updater/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Fragment filenames are discovered by prefix in `merge`. */
const FRAGMENT_PREFIX = "_updater-";

function log(message) {
  console.log(`[updater-manifest] ${message}`);
}
function fail(message) {
  console.error(`[updater-manifest] ERROR: ${message}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`expected a --flag, got "${key}"`);
    const value = argv[i + 1];
    if (value === undefined) fail(`${key} requires a value`);
    flags[key.slice(2)] = value;
  }
  return flags;
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- emit

function emit(flags) {
  const platform = flags.platform;
  if (!platform) fail("emit requires --platform");
  if (!isValidPlatformKey(platform)) {
    fail(
      `--platform "${platform}" is not a Tauri updater target key. ` +
        `A typo here means "no update for this platform, forever".`
    );
  }
  const outDir = path.resolve(root, flags.out ?? "installers");
  // Fragments land in a SEPARATE directory from the installers on purpose: the
  // release-upload step globs the installer dir, so a fragment written there
  // gets attached to the public Release as a stray build artifact (it happened
  // on v1.5.0 — three `_updater-*.json` files shipped as release assets).
  const fragmentDir = path.resolve(root, flags["fragment-out"] ?? outDir);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(fragmentDir, { recursive: true });

  const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
  if (!existsSync(bundleRoot)) {
    fail(`no bundle directory at ${bundleRoot} — did tauri build run?`);
  }

  // `createUpdaterArtifacts` signs more bundles than it can update — Linux gets
  // BOTH a .AppImage.sig and a .deb.sig, though a .deb can never self-update —
  // so the artifact is chosen by what this platform can actually install, not
  // by count. selectUpdaterSignature throws on zero or ambiguous matches rather
  // than picking one.
  const sigs = walk(bundleRoot).filter((f) => f.endsWith(".sig"));
  let sigPath;
  try {
    sigPath = selectUpdaterSignature(sigs, platform);
  } catch (e) {
    fail(`${e.message}\n(searched ${bundleRoot})`);
    return;
  }
  const assetPath = sigPath.slice(0, -".sig".length);
  if (!existsSync(assetPath)) {
    fail(`signature ${sigPath} has no matching artifact at ${assetPath}`);
  }

  const version = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  ).version;

  const assetName = updaterAssetName(path.basename(assetPath), platform);
  const destPath = path.join(outDir, assetName);

  // The collect step writes into this same directory, and on Windows/Linux it
  // handles the SAME artifact we do (the NSIS exe, the AppImage). Landing on the
  // same name is therefore expected and fine — but landing on the same name with
  // DIFFERENT bytes would mean the two steps disagree about which file is the
  // release artifact, and `gh release upload` would collapse them onto one asset
  // non-deterministically. Fail rather than let that reach a Release.
  if (existsSync(destPath)) {
    const existing = statSync(destPath);
    const incoming = statSync(assetPath);
    if (existing.size !== incoming.size) {
      fail(
        `${destPath} already exists with a different size (${existing.size} vs ${incoming.size}).\n` +
          `Another step wrote a different file under this name — the collect step and the ` +
          `updater emit step must agree on asset naming.`
      );
    }
  }

  copyFileSync(assetPath, destPath);

  const fragment = {
    platform,
    version,
    asset: assetName,
    // CONTENT, not a path: Tauri expects the literal signature string here.
    signature: readFileSync(sigPath, "utf8").trim(),
  };
  const fragmentPath = path.join(fragmentDir, `${FRAGMENT_PREFIX}${platform}.json`);
  writeFileSync(fragmentPath, JSON.stringify(fragment, null, 2) + "\n");

  const sizeMb = (statSync(destPath).size / (1024 * 1024)).toFixed(1);
  log(`${platform}: ${assetName} (${sizeMb} MB) + fragment`);
}

// ---------------------------------------------------------------- merge

function merge(flags) {
  const dir = path.resolve(root, flags.dir ?? "artifacts");
  const repo = flags.repo;
  const tag = flags.tag;
  if (!repo) fail("merge requires --repo owner/repo");
  if (!tag) fail("merge requires --tag");
  if (!existsSync(dir)) fail(`no such directory: ${dir}`);

  const fragmentPaths = walk(dir).filter(
    (f) => path.basename(f).startsWith(FRAGMENT_PREFIX) && f.endsWith(".json")
  );
  log(`found ${fragmentPaths.length} fragment(s) under ${dir}`);

  const fragments = fragmentPaths.map((f) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      fail(`could not parse fragment ${f}: ${e.message}`);
    }
  });

  let manifest;
  try {
    manifest = buildManifest(fragments, {
      repo,
      tag,
      pubDate: flags["pub-date"] ?? new Date().toISOString(),
    });
  } catch (e) {
    fail(e.message);
    return;
  }

  const outPath = path.resolve(root, flags.out ?? "latest.json");
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

  log(`version ${manifest.version}, platforms: ${Object.keys(manifest.platforms).join(", ")}`);
  log(`wrote ${outPath}`);
  return manifest;
}

/**
 * HEAD every URL in the manifest and fail if any doesn't resolve.
 *
 * This exists because a manifest can be structurally perfect — valid JSON,
 * correct signatures, every platform present — and still be entirely dead. On
 * v1.5.0 all four URLs 404'd, because GitHub rewrites spaces in asset names to
 * dots at upload time and the URLs were built from the local filenames. Every
 * CI job was green. The only way to catch that class of bug is to actually
 * fetch what we just published, so a release now fails loudly instead of
 * telling users an update is available and then handing them a 404.
 *
 * Runs AFTER the build jobs have uploaded their installers (the aggregation
 * job depends on all of them) and BEFORE latest.json is attached, so a failure
 * here leaves the previous release's manifest serving rather than replacing it
 * with a broken one.
 */
async function verifyAssetUrls(manifest) {
  const failures = [];
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    let status = 0;
    try {
      const res = await fetch(entry.url, { method: "HEAD", redirect: "follow" });
      status = res.status;
    } catch (e) {
      failures.push(`${platform}: ${entry.url} — request failed (${e.message})`);
      continue;
    }
    if (status !== 200) {
      failures.push(`${platform}: HTTP ${status} — ${entry.url}`);
    } else {
      log(`  OK  ${platform} -> ${decodeURIComponent(entry.url.split("/").pop())}`);
    }
  }
  if (failures.length) {
    fail(
      `${failures.length} of ${Object.keys(manifest.platforms).length} updater URLs do not resolve:\n  ` +
        failures.join("\n  ") +
        `\n\nThe manifest was NOT published. Asset names on the Release must match the URLs ` +
        `in latest.json exactly — note GitHub rewrites spaces to dots at upload time.`
    );
  }
  log(`all ${Object.keys(manifest.platforms).length} updater URLs resolve`);
}

// ---------------------------------------------------------------- main

const [mode, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (mode) {
  case "emit":
    emit(flags);
    break;
  case "merge": {
    const manifest = merge(flags);
    // Opt-in because it needs the assets to already be on the Release — true in
    // the aggregation job, not when merging downloaded artifacts locally.
    if (flags["verify-urls"] === "true" && manifest) {
      await verifyAssetUrls(manifest);
    }
    break;
  }
  default:
    fail(`unknown mode "${mode ?? ""}". Expected "emit" or "merge".`);
}
