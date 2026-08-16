// Pass 2: of the unguarded routes, which actually READ real user data?
// A route only leaks if it reaches a real-data source. Classify by source
// module, so each verdict cites the file that produced it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SRC = path.join(ROOT, "src");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(SRC);
const norm = (p) => p.replace(/\\/g, "/");
const read = new Map();
for (const f of files) read.set(norm(f), fs.readFileSync(f, "utf8"));

function resolve(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")])
    if (read.has(norm(c))) return norm(c);
  return null;
}
const importsOf = new Map();
for (const [f, src] of read) {
  const s = new Set();
  const re = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) { const r = resolve(m[1], f); if (r) s.add(r); }
  importsOf.set(f, [...s]);
}

// Real-data sources: things that touch the user's actual machine/history.
const SOURCE_TESTS = {
  "claude-home": (f, s) => /homedir\s*\(\)|\.claude\b/.test(s) && !/lib\/demo\//.test(f),
  "index-db": (f) => /lib\/db\/(queries|otelQueries|connection|ingest)/.test(f) || /lib\/data\/.*FromDb/.test(f),
  "project-scan": (f) => /lib\/scanner\//.test(f),
  "tasks-db": (f) => /lib\/tasks\//.test(f),
  "usage-parse": (f) => /lib\/usage\/(parser|fileActivity|aggregator)/.test(f),
};
const sourcesOf = new Map();
for (const [f, s] of read) {
  const hits = new Set();
  for (const [name, test] of Object.entries(SOURCE_TESTS)) if (test(f, s)) hits.add(name);
  sourcesOf.set(f, hits);
}

function reachedSources(start) {
  const seen = new Set([start]);
  const stack = [start];
  const out = new Map();
  while (stack.length) {
    const f = stack.pop();
    for (const s of sourcesOf.get(f) ?? []) if (!out.has(s)) out.set(s, f.replace(norm(SRC) + "/", ""));
    for (const d of importsOf.get(f) ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  }
  return out;
}

const auditPath = path.join(HERE, "demo-audit.json");
if (!fs.existsSync(auditPath)) {
  console.error("Run pass1-guard-reachability.mjs first — it writes demo-audit.json.");
  process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const gap = audit.filter((r) => !r.readGuard);

const leaks = [], clean = [];
for (const r of gap) {
  const file = norm(path.join(SRC, "app/api", r.route, "route.ts"));
  const srcs = reachedSources(file);
  const rec = { ...r, sources: [...srcs.keys()], via: [...srcs.values()][0] ?? null };
  (srcs.size ? leaks : clean).push(rec);
}
console.log(`UNGUARDED-FOR-READS: ${gap.length}\n  reaches real data: ${leaks.length}\n  no real-data path: ${clean.length}\n`);
console.log("=== LEAKS (unguarded reads that reach real user data) ===");
for (const r of leaks.sort((a, b) => a.route.localeCompare(b.route)))
  console.log(`  ${r.route.padEnd(46)} ${r.sources.join("+")}${r.writeGuard ? " (write-guarded)" : ""}`);
console.log("\n=== NO REAL-DATA PATH (no guard needed) ===");
for (const r of clean.sort((a, b) => a.route.localeCompare(b.route))) console.log(`  ${r.route}`);
fs.writeFileSync(path.join(HERE, "demo-leaks.json"), JSON.stringify({ leaks, clean }, null, 2));
