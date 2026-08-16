// W12 demo-mode coverage audit.
// Classifies every API route by whether it can transitively reach a demoMode()
// read-guard, a demoWriteBlock() write-guard, or neither. Import-graph based:
// the plan's standing rule is that a leak counts only when the CODE shows a
// real-data read, never from what a page rendered.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(HERE, "demo-audit.json"); // git-ignored; pass 2 reads it

// ---- collect all source files -------------------------------------------
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

// ---- resolve a local import specifier to a file --------------------------
function resolve(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // package import
  const cands = [
    base + ".ts", base + ".tsx",
    path.join(base, "index.ts"), path.join(base, "index.tsx"),
  ];
  for (const c of cands) if (read.has(norm(c))) return norm(c);
  return null;
}

const importsOf = new Map();
for (const [f, src] of read) {
  const specs = new Set();
  const re = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const r = resolve(m[1], f);
    if (r) specs.add(r);
  }
  importsOf.set(f, [...specs]);
}

// ---- direct guard markers -----------------------------------------------
const READ_GUARD = /\bdemoMode\s*\(|\bdemoModeEnv\s*\(/;
const WRITE_GUARD = /\bdemoWriteBlock\s*\(/;
const hasRead = new Map(), hasWrite = new Map();
for (const [f, src] of read) {
  const body = src.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?/gm, "");
  hasRead.set(f, READ_GUARD.test(body));
  hasWrite.set(f, WRITE_GUARD.test(body));
}
// The guard definitions themselves are not coverage.
for (const f of [...read.keys()].filter((f) => /lib\/demo\/demo(Mode|WriteGuard)\.ts$/.test(f))) {
  hasRead.set(f, false);
  hasWrite.set(f, false);
}

// ---- transitive reachability (memoized DFS, cycle-safe) ------------------
function reaches(start, marker) {
  const seen = new Set();
  const stack = [start];
  const why = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (marker.get(f)) { why.push(f); return why; }
    for (const d of importsOf.get(f) ?? []) stack.push(d);
  }
  return null;
}

// ---- classify routes ----------------------------------------------------
const routes = [...read.keys()].filter((f) => /\/app\/api\/.*\/route\.ts$/.test(f));
const rows = [];
for (const r of routes) {
  const readHit = reaches(r, hasRead);
  const writeHit = reaches(r, hasWrite);
  const methods = [...read.get(r).matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]);
  rows.push({
    route: r.replace(norm(SRC) + "/app/api/", "").replace(/\/route\.ts$/, ""),
    methods: methods.join(","),
    readGuard: readHit ? readHit[0].replace(norm(SRC) + "/", "") : null,
    writeGuard: writeHit ? writeHit[0].replace(norm(SRC) + "/", "") : null,
  });
}

const unguarded = rows.filter((r) => !r.readGuard && !r.writeGuard);
const readOnlyGuarded = rows.filter((r) => r.readGuard);
const writeOnlyGuarded = rows.filter((r) => !r.readGuard && r.writeGuard);

console.log(`TOTAL ROUTES: ${rows.length}`);
console.log(`READ-GUARDED (transitively): ${readOnlyGuarded.length}`);
console.log(`WRITE-GUARDED ONLY: ${writeOnlyGuarded.length}`);
console.log(`NO GUARD AT ALL: ${unguarded.length}`);
console.log("\n=== NO GUARD AT ALL ===");
for (const r of unguarded.sort((a, b) => a.route.localeCompare(b.route))) {
  console.log(`  ${r.route}  [${r.methods || "?"}]`);
}
console.log("\n=== WRITE-GUARDED ONLY (reads may still leak) ===");
for (const r of writeOnlyGuarded.sort((a, b) => a.route.localeCompare(b.route))) {
  console.log(`  ${r.route}  [${r.methods || "?"}]`);
}

fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
