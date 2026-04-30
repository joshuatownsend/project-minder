import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const stats = JSON.parse(fs.readFileSync(path.join(root, ".next/diagnostics/route-bundle-stats.json"), "utf8"));

const sorted = stats.slice().sort((a, b) => b.firstLoadUncompressedJsBytes - a.firstLoadUncompressedJsBytes);

console.log("Route".padEnd(34) + "First-load JS (KB uncompressed)");
console.log("-".repeat(64));
for (const s of sorted) {
  console.log(s.route.padEnd(34) + (s.firstLoadUncompressedJsBytes / 1024).toFixed(1));
}

const counts = {};
for (const s of stats) for (const c of s.firstLoadChunkPaths) counts[c] = (counts[c] ?? 0) + 1;

const sharedAll = Object.keys(counts).filter((c) => counts[c] === stats.length);
console.log("\nChunks shared across all " + stats.length + " routes:");
let totalShared = 0;
for (const c of sharedAll) {
  const abs = path.join(root, c.replace(/\\/g, "/"));
  try {
    const sz = fs.statSync(abs).size;
    totalShared += sz;
    const name = c.split(/[\\/]/).pop();
    console.log("  " + (sz / 1024).toFixed(1).padStart(8) + " KB  " + name);
  } catch {
    /* skip */
  }
}
console.log("Total shared:", (totalShared / 1024).toFixed(1), "KB");

const allChunks = new Set();
for (const s of stats) for (const c of s.firstLoadChunkPaths) allChunks.add(c);
let totalAll = 0;
for (const c of allChunks) {
  try {
    totalAll += fs.statSync(path.join(root, c.replace(/\\/g, "/"))).size;
  } catch {
    /* skip */
  }
}
console.log("\nTotal first-load chunks (union across routes):", (totalAll / 1024).toFixed(1), "KB");
