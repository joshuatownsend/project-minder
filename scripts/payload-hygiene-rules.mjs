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
export const FORBIDDEN_SUMMARY = ".git, .env*, .claude, .mcp.json, agentlytics-repo";

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
