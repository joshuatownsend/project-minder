// Payload hygiene gate for the C4 packaging workflow (issue #284).
//
// The standalone packager's dependency walk has over-traced into the repo root
// before, producing a `dist/minder-server` that contained `.git` (29 MB),
// `.env.local` (secrets!), `.claude/`, `.mcp.json`, and even a stray sibling
// repo `agentlytics-repo/`. CI checkouts start clean so most of that can't
// recur there, but a bad walk could still pull a forbidden entry into the
// bundle — and once it ships in an installer it's public. This script fails the
// build BEFORE `tauri build` bundles the payload if any forbidden entry is
// found anywhere under the packaged dir.
//
// It is a GUARD, not a fix of the packager (the walk logic itself is tracked in
// #284) — it never mutates the payload, only inspects it.
//
// Usage:  node scripts/verify-payload-hygiene.mjs [payloadDir]
//   payloadDir defaults to dist/minder-server (relative to repo root).
// Exit 0 = clean; exit 1 = forbidden entries found (or dir missing).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const arg = process.argv[2];
const payloadDir = arg
  ? path.resolve(arg)
  : path.join(root, "dist", "minder-server");

// Forbidden basenames (exact, case-insensitive) at ANY depth in the payload.
const FORBIDDEN_EXACT = new Set([
  ".git",
  ".claude",
  ".mcp.json",
  "agentlytics-repo",
]);

// Forbidden basename patterns: any dotenv file (.env, .env.local, .env.*).
function isForbiddenName(name) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_EXACT.has(lower)) return true;
  // `.env`, `.env.local`, `.env.production`, … but NOT e.g. `.environmentrc`
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  return false;
}

function fail(message) {
  console.error(`[payload-hygiene] ERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(payloadDir)) {
  fail(
    `payload dir not found: ${payloadDir}. Run "pnpm build && pnpm package:standalone" first.`
  );
}

// Recursively walk, collecting every forbidden path. We do NOT follow links out
// of the payload: `readdirSync(withFileTypes)` returns Dirents whose type comes
// from the entry itself (lstat-like, never dereferenced), so a directory
// symlink OR a Windows junction reports `isSymbolicLink() === true` and
// `isDirectory() === false` — the recursion guard below skips both. A link
// named `.git` is still caught by name (the name check runs before the type
// check), so nothing forbidden slips through; we just never descend THROUGH a
// link (no escaping the payload, no cycles). This is defense-in-depth anyway:
// package-standalone.mjs fully dereferences the payload, so real forbidden
// content is materialized in place and caught by name regardless.
const offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory we can't read is suspicious but not itself a leak; warn and
    // continue rather than crash the whole gate.
    console.warn(
      `[payload-hygiene] WARNING: could not read ${dir} (${String(err.message).split("\n")[0]})`
    );
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isForbiddenName(entry.name)) {
      offenders.push(path.relative(payloadDir, full));
      // Don't descend into a forbidden dir — its presence is already a failure
      // and it may be huge (a nested `.git`).
      continue;
    }
    // Recurse into real subdirectories only. isDirectory() is already false for
    // symlinks/junctions on the Node the packaging job runs (see the walk
    // comment above); the explicit isSymbolicLink() skip makes that intent
    // load-bearing and defends any Node build that surfaces a link as a plain
    // directory.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(full);
    }
  }
}

walk(payloadDir);

if (offenders.length > 0) {
  console.error(
    `[payload-hygiene] ERROR: ${offenders.length} forbidden entr${
      offenders.length === 1 ? "y" : "ies"
    } found in the packaged payload (${payloadDir}):`
  );
  for (const o of offenders.sort()) {
    console.error(`  - ${o}`);
  }
  console.error(
    "These must never ship in an installer. This is the issue #284 over-tracing " +
      "guard — inspect scripts/package-standalone.mjs's walk if this fires in CI."
  );
  process.exit(1);
}

console.log(
  `[payload-hygiene] OK: no forbidden entries (.git, .env*, .claude, .mcp.json, ` +
    `agentlytics-repo) under ${path.relative(root, payloadDir) || payloadDir}`
);
