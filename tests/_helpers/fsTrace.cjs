// Preloaded with `node --require` into the lint CLI by lintFingerprintConformance.test.ts. Appends
// "<op> <absolute path>" to $FSTRACE_OUT for every path handed to an fs call (once per op+path).
// Test tooling only: nothing in the app loads this.
const fs = require("fs");
const path = require("path");

const out = process.env.FSTRACE_OUT;
const seen = new Set();

function record(op, p) {
  if (!out) return;
  try {
    const text = p instanceof URL ? require("url").fileURLToPath(p) : typeof p === "string" || Buffer.isBuffer(p) ? String(p) : null;
    if (text === null || text.startsWith("node:")) return;
    const key = op + " " + path.resolve(text);
    if (seen.has(key)) return;
    seen.add(key);
    fs.appendFileSync(out, key + "\n");
  } catch {
    // tracing must never change what the CLI does
  }
}

const SYNC_AND_CALLBACK = [
  "readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "accessSync", "openSync",
  "realpathSync", "opendirSync", "readlinkSync",
  "readFile", "stat", "lstat", "readdir", "access", "open", "realpath", "opendir", "readlink", "exists",
];
for (const name of SYNC_AND_CALLBACK) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function patched(p, ...rest) {
    record(name, p);
    return original.call(this, p, ...rest);
  };
  if (name === "realpathSync" && original.native) fs[name].native = original.native;
}

for (const name of ["readFile", "stat", "lstat", "readdir", "access", "open", "realpath", "opendir", "readlink"]) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = function patched(p, ...rest) {
    record("p." + name, p);
    return original.call(this, p, ...rest);
  };
}
