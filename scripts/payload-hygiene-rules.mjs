// Shared forbidden-entry rules for the standalone payload (issue #284).
//
// Two consumers, deliberately kept in lockstep by importing this module:
//   - scripts/package-standalone.mjs PRUNES matching entries while copying, so
//     over-traced repo files (.git, .env.local secrets, sibling repos) never
//     materialize in dist/minder-server in the first place;
//   - scripts/verify-payload-hygiene.mjs independently WALKS the finished
//     payload and fails the CI build if anything matching is present — the
//     backstop that catches a regression in the pruning itself.

// Forbidden basenames (exact, case-insensitive) at ANY depth in the payload.
export const FORBIDDEN_EXACT = new Set([
  ".git",
  ".claude",
  ".mcp.json",
  "agentlytics-repo",
]);

// Human-readable summary for log lines, kept next to the rules it describes.
export const FORBIDDEN_SUMMARY =
  ".git, .env*, .claude, .mcp.json, agentlytics-repo, dist/node";

// Forbidden paths anchored at the PAYLOAD ROOT, unlike FORBIDDEN_EXACT which
// matches a basename at any depth. Anchoring is the whole point here: `node` is
// far too common a directory name to ban outright (node_modules/.bin/node, and
// plenty of packages ship a `node` subdir), so only the specific root-relative
// location is forbidden.
//
// `dist/node` is the ~79 MB Node runtime fetched by fetch-node-runtime.mjs.
// tauri.conf.json bundles it separately as its own `node` resource, so a copy
// inside the payload puts the whole runtime in every installer twice. The
// tracer only sweeps it in when it already exists from an earlier build (see
// next.config.ts) — which means it never fires on a clean CI run and would go
// unnoticed until someone reorders the build steps or adds `dist/` caching.
// That is exactly the kind of silent regression this gate exists to catch.
export const FORBIDDEN_ROOT_RELATIVE = new Set(["dist/node"]);

// `relPath` is a payload-root-relative path in either separator style.
export function isForbiddenRootRelative(relPath) {
  if (!relPath) return false;
  return FORBIDDEN_ROOT_RELATIVE.has(relPath.replace(/\\/g, "/").toLowerCase());
}

// Maximum allowed path length INSIDE the payload, relative to the payload root.
// Budget: Windows MAX_PATH is 260, makensis (Tauri's NSIS bundler) is not
// long-path-aware, and the GitHub runner prefix it reads the payload through —
// `D:\a\project-minder\project-minder\src-tauri\..\dist\minder-server\` — is
// 66 chars. 260 - 66 = 194; 180 leaves margin for a slightly longer checkout
// prefix. package-standalone.mjs keeps paths under this by shortening
// peer-suffixed .pnpm store keys; the gate fails the build if anything exceeds
// it, so the overflow surfaces at package time with the offending path — not
// as makensis' cryptic "Error in script on line N".
export const MAX_PAYLOAD_REL_PATH = 180;

// Forbidden basename patterns: any name starting with `.env` — true `.env*`
// prefix semantics, matching the `.env*` guarantee the workflow/CHANGELOG make.
// Covers `.env`, `.env.local`, `.env.production`, direnv's `.envrc`, `.env.bak`,
// etc. No legitimate standalone-payload file starts with `.env` (Next's
// standalone output and node_modules contain none), so the broad prefix has no
// known false positives — if a real payload file ever legitimately starts with
// `.env`, surface it rather than silently special-casing.
export function isForbiddenName(name) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_EXACT.has(lower)) return true;
  if (lower.startsWith(".env")) return true;
  return false;
}
