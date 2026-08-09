#!/usr/bin/env node
/**
 * NFT census — diagnose Next's file-tracing output for issue #284.
 *
 * `next build` emits one `.nft.json` per route listing every file that route's
 * standalone output needs. When tracing works, a route lists only its
 * externalized packages: our first-party `src/` modules are bundled into
 * `route.js` and never appear. When it falls back, the route lists essentially
 * the whole repository instead.
 *
 * This script classifies every manifest so the failure is a measurement rather
 * than an impression. Two things make that necessary:
 *
 *  - The build's own "unexpected file in NFT list" warning count is useless.
 *    On 16.3.0 it prints zero while the sweep is fully intact.
 *  - The result is bimodal (all of `src/` or none of it), so a partial fix is
 *    indistinguishable from no fix. Only the bucket counts tell you anything.
 *
 * Usage:
 *   node scripts/nft-census.mjs             # summary + per-bucket totals
 *   node scripts/nft-census.mjs --verbose   # list every route
 *   node scripts/nft-census.mjs --route app/api/adapters/route
 *
 * Requires a completed `pnpm build` (reads `.next/server`, never writes).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, ".next/server");

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");

// `--route` with no value (end of argv, or another flag next) would otherwise
// leave `only` undefined and silently run the full census — the one output a
// typo'd route name must not produce, since it looks like a successful run.
let only = null;
if (argv.includes("--route")) {
  const value = argv[argv.indexOf("--route") + 1];
  if (!value || value.startsWith("--")) {
    console.error("--route requires a route name, e.g. --route app/api/adapters/route");
    process.exit(2);
  }
  only = value;
}

// A route is "swept" if it traces more than this many first-party src/ files.
// Real values observed are 0-18 (genuine runtime reads) or 909 (the sweep), so
// the threshold is not sensitive.
const SWEEP_THRESHOLD = 50;

function findManifests(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, out);
    else if (entry.name.endsWith(".nft.json")) out.push(full);
  }
  return out;
}

/** Bucket a traced path by the top-level repo directory it resolves into. */
function bucketOf(rel) {
  if (rel.startsWith("..")) return "OUTSIDE-REPO";
  if (rel.includes("node_modules/")) return "node_modules";
  const top = rel.split("/")[0];
  return top.startsWith(".next") ? ".next" : top || "(root file)";
}

function analyze(manifestPath) {
  const base = path.dirname(manifestPath);
  let files;
  try {
    files = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files;
  } catch {
    return null;
  }
  // A manifest can parse cleanly and still not have the shape we expect
  // (`files: null`, or a future/partial format). Skip it rather than letting
  // the iteration below throw and abort a census over 200+ files — the count
  // of skipped manifests is reported so a silent shape change is still
  // visible.
  if (!Array.isArray(files)) return null;
  const buckets = new Map();
  for (const f of files) {
    const rel = path.relative(ROOT, path.resolve(base, f)).split(path.sep).join("/");
    const b = bucketOf(rel);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  return {
    route: path
      .relative(SERVER, manifestPath)
      .split(path.sep)
      .join("/")
      .replace(/\.js\.nft\.json$/, ""),
    total: files.length,
    buckets,
    src: buckets.get("src") ?? 0,
  };
}

const manifests = findManifests(SERVER);
if (manifests.length === 0) {
  console.error("No .nft.json files under .next/server — run `pnpm build` first.");
  process.exit(1);
}

const rows = manifests.map(analyze).filter(Boolean);
const skipped = manifests.length - rows.length;
if (skipped > 0) {
  console.warn(
    `warning: skipped ${skipped} manifest(s) that were unreadable or had no files[] array`
  );
}

if (only) {
  const row = rows.find((r) => r.route === only);
  if (!row) {
    console.error(`No manifest for route "${only}".`);
    process.exit(1);
  }
  console.log(`${row.route}  total=${row.total}`);
  for (const [b, n] of [...row.buckets].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${b}`);
  }
  process.exit(0);
}

const swept = rows.filter((r) => r.src > SWEEP_THRESHOLD);
const bounded = rows.filter((r) => r.src <= SWEEP_THRESHOLD);

console.log(`manifests: ${rows.length}   swept: ${swept.length}   bounded: ${bounded.length}`);

// Distinct src-counts among swept routes. A single value means one uniform
// fallback; a spread would mean several independent causes.
const distinct = new Map();
for (const r of swept) distinct.set(r.src, (distinct.get(r.src) ?? 0) + 1);
if (distinct.size) {
  console.log("\nswept routes by src-file count:");
  for (const [n, c] of [...distinct].sort((a, b) => a[0] - b[0])) {
    console.log(`  src=${n}  ->  ${c} route(s)`);
  }
}

// The node_modules total is the invariant that matters when editing
// outputFileTracingExcludes: the exclude globs are substring matches, so a
// careless entry can prune real dependencies. This number must not drop.
const nmCounts = rows.map((r) => r.buckets.get("node_modules") ?? 0);
console.log(
  `\nnode_modules entries per route: min=${Math.min(...nmCounts)} max=${Math.max(...nmCounts)}`
);

const worst = swept.sort((a, b) => b.total - a.total)[0];
if (worst) {
  console.log(`\nlargest swept trace: ${worst.route} (total=${worst.total})`);
  for (const [b, n] of [...worst.buckets].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(n).padStart(6)}  ${b}`);
  }
}

if (verbose) {
  console.log("\n=== all routes ===");
  for (const r of rows.sort((a, b) => b.total - a.total)) {
    console.log(
      `  ${r.src > SWEEP_THRESHOLD ? "SWEPT  " : "bounded"} total=${String(r.total).padStart(5)} src=${String(r.src).padStart(4)}  ${r.route}`
    );
  }
}
