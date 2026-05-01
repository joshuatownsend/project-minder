// One-off profiler for reconcileSessionFile. Picks a sample of JSONL files
// across size buckets, force-reconciles each, and prints per-stage timings
// gathered via the MINDER_PROFILE_INGEST=1 hooks in `ingest.ts`.
//
// Usage:
//   node scripts/profile-reconcile.mjs              # 10-session sample
//   node scripts/profile-reconcile.mjs --count=20   # custom sample size
//
// Side effects: opens ~/.minder/index.db and force-reconciles real session
// rows. Idempotent — DERIVED_VERSION is stable so the rewritten rows match
// what was there before. Does NOT clear the v3 readiness flag (no full
// pass), so safe to run while the indexer is otherwise active.

import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs, statSync } from "node:fs";
import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

process.env.MINDER_PROFILE_INGEST = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const argv = process.argv.slice(2);
const countArg = argv.find((a) => a.startsWith("--count="));
const DEFAULT_COUNT = 10;
const parsedCount = countArg ? Number.parseInt(countArg.split("=")[1], 10) : DEFAULT_COUNT;
const COUNT =
  Number.isInteger(parsedCount) && parsedCount >= 1 ? parsedCount : DEFAULT_COUNT;

// Bundle ingest.ts (and its deps) into an ESM module we can import here.
const tmpFile = path.join(os.tmpdir(), `pm-profile-ingest-${Date.now()}.mjs`);
await build({
  entryPoints: [path.join(root, "src", "lib", "db", "ingest.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: tmpFile,
  tsconfig: path.join(root, "tsconfig.json"),
  external: ["better-sqlite3", "chokidar"],
  alias: { "server-only": path.join(here, "server-only-noop.mjs") },
});

const ingest = await import(pathToFileURL(tmpFile).href);

const projectsDir = path.join(os.homedir(), ".claude", "projects");
const dbPath = path.join(os.homedir(), ".minder", "index.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// Discover all JSONL files with sizes.
const files = [];
const dirs = await fs.readdir(projectsDir, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory()) continue;
  const dirPath = path.join(projectsDir, d.name);
  const entries = await fs.readdir(dirPath);
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dirPath, f);
    try {
      const s = statSync(fp);
      files.push({ filePath: fp, dirName: d.name, size: s.size });
    } catch {
      // ignore
    }
  }
}

// Sample across log10 size buckets — same shape used by the user's grep
// earlier, tuned for the count.
files.sort((a, b) => a.size - b.size);
const buckets = new Map();
for (const f of files) {
  const b = Math.floor(Math.log10(Math.max(1, f.size)));
  const list = buckets.get(b) ?? [];
  list.push(f);
  buckets.set(b, list);
}
const sortedBuckets = Array.from(buckets.values()).sort(
  (a, b) => a[0].size - b[0].size
);
const sample = [];
const perBucket = Math.max(1, Math.ceil(COUNT / sortedBuckets.length));
for (const list of sortedBuckets) {
  for (let i = 0; i < Math.min(perBucket, list.length) && sample.length < COUNT; i++) {
    sample.push(list[i]);
  }
}

await ingest.loadPricing?.();

console.log(`profiling ${sample.length} sessions across ${sortedBuckets.length} size buckets\n`);

const header = ["bytes", "totalMs", "fileRead", "parseTurns", "classify", "oneShot", "wrSes", "wrDel", "wrChild", "rows"];
console.log(header.join("\t"));

const totals = {
  totalMs: 0, fileRead: 0, parseTurns: 0,
  "classify+price": 0, detectOneShot: 0,
  "write.delete": 0, "write.insertSession": 0, "write.insertChildren": 0,
  rows: 0,
};

for (const { filePath, dirName, size } of sample) {
  ingest.resetIngestTimings();
  const t0 = performance.now();
  let rows = 0;
  try {
    const result = await ingest.reconcileSessionFile(db, filePath, dirName, { force: true });
    rows = result.rowsWritten;
  } catch (err) {
    console.error(`error on ${filePath}:`, err.message);
    continue;
  }
  const totalMs = performance.now() - t0;
  const t = ingest.getIngestTimings();
  const row = [
    size,
    totalMs.toFixed(1),
    (t.fileRead ?? 0).toFixed(1),
    (t.parseTurns ?? 0).toFixed(1),
    (t["classify+price"] ?? 0).toFixed(1),
    (t.detectOneShot ?? 0).toFixed(1),
    (t["write.insertSession"] ?? 0).toFixed(1),
    (t["write.delete"] ?? 0).toFixed(1),
    (t["write.insertChildren"] ?? 0).toFixed(1),
    rows,
  ];
  console.log(row.join("\t"));
  totals.totalMs += totalMs;
  totals.fileRead += t.fileRead ?? 0;
  totals.parseTurns += t.parseTurns ?? 0;
  totals["classify+price"] += t["classify+price"] ?? 0;
  totals.detectOneShot += t.detectOneShot ?? 0;
  totals["write.delete"] += t["write.delete"] ?? 0;
  totals["write.insertSession"] += t["write.insertSession"] ?? 0;
  totals["write.insertChildren"] += t["write.insertChildren"] ?? 0;
  totals.rows += rows;
}

function pct(n) {
  if (totals.totalMs <= 0) return "0.0";
  return ((n / totals.totalMs) * 100).toFixed(1);
}
console.log("\n--- Totals ---");
console.log(`total wall time:        ${totals.totalMs.toFixed(1)} ms`);
console.log(`fileRead:               ${totals.fileRead.toFixed(1)} ms (${pct(totals.fileRead)}%)`);
console.log(`parseTurns:             ${totals.parseTurns.toFixed(1)} ms (${pct(totals.parseTurns)}%)`);
console.log(`classify+price:         ${totals["classify+price"].toFixed(1)} ms (${pct(totals["classify+price"])}%)`);
console.log(`detectOneShot:          ${totals.detectOneShot.toFixed(1)} ms (${pct(totals.detectOneShot)}%)`);
console.log(`write.delete:           ${totals["write.delete"].toFixed(1)} ms (${pct(totals["write.delete"])}%)`);
console.log(`write.insertSession:    ${totals["write.insertSession"].toFixed(1)} ms (${pct(totals["write.insertSession"])}%)`);
console.log(`write.insertChildren:   ${totals["write.insertChildren"].toFixed(1)} ms (${pct(totals["write.insertChildren"])}%)`);
console.log(`rows written:           ${totals.rows}`);
console.log(`mean per session:       ${(totals.totalMs / sample.length).toFixed(1)} ms`);
console.log(`projected throughput:   ${(60000 / (totals.totalMs / sample.length)).toFixed(1)} sessions/min`);

db.close();
await fs.rm(tmpFile).catch(() => {});
