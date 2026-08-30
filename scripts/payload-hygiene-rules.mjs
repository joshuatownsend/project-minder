import { rootLevelGitignoredEntries } from "./gitignored-roots.mjs";

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
  // This repo's own supported git-worktree location (`.gitignore:73-74`). A
  // checkout with a live worktree there holds a second full copy of the
  // source tree inside the tracing root, which the whole-root tracing
  // fallback (#284) sweeps exactly the way it swept `agentlytics-repo`.
  // Excluded at the tracer in next.config.ts too; listed here so the two ends
  // of the pipeline agree on what may not ship, and so the CI backstop fails
  // loudly rather than a release quietly carrying someone's feature branch.
  // Nested worktrees also nest deeply, so this doubles as protection against
  // MAX_PAYLOAD_REL_PATH aborts during packaging.
  ".worktrees",
  // The developer's own Minder config (gitignored, present in any checkout
  // where setup has run): scan roots, per-project statuses, port overrides,
  // notification prefs, feature flags. Shipping it seeds every install with
  // someone else's configuration rather than merely leaking it. The runtime
  // never wants a payload copy — config.ts resolves it under
  // `resolveStateDir()`, the user's own state directory.
  ".minder.json",
  // Generated / downloaded developer state, all gitignored and all sitting in
  // the tracing root where the #284 fallback sweeps them. `.agents` is the one
  // that was actually observed in `.next/standalone`; the rest are the same
  // shape and were added with it rather than one review round at a time.
  // Names are distinctive enough for a basename rule — verified no package in
  // this tree uses any of them, unlike `.cache` above.
  ".design-fetch",
  ".codegraph",
  ".playwright-mcp",
  ".agents",
  ".claudelint-cache",
]);

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
//
// `.cache` is root-anchored for the same reason `node` is, and here the
// reason is not hypothetical. `node_modules/<pkg>/.cache/` is an ordinary
// location, and one package in this tree uses it for something essential:
// `@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2/` holds the
// downloaded embedding model — weights included — that backs semanticSearch.
// A basename rule, or an unanchored tracer glob, prunes it. That was measured
// while adding this: `./.cache/**` in next.config.ts dropped the traced
// node_modules count on /api/health from 372 to 368, those four files being
// the model. So the tracer cannot express this rule (its globs are
// substring matches with no anchoring) and it lives only here, where it can
// be anchored to the payload root.
//
// What it protects: the checkout's OWN `.cache/` is gitignored
// (`.gitignore:30`) and holds developer-specific state rather than disposable
// build output — `claudeStatsCache.ts` writes `.cache/claude-stats.json`
// keyed by ABSOLUTE transcript paths, with per-file token, tool, model and
// error counts, and `resolveStateDir()` falls back to the checkout root
// during ordinary development. A local release build from a checkout that has
// run Minder would otherwise publish it.
export const FORBIDDEN_ROOT_RELATIVE = new Set([
  "dist/node",
  ".cache",
  // The Tauri crate. Nothing under it is read at server runtime — the only
  // reference to it from `src/` is a comment — but it cannot be left to the
  // tracer's `./src-tauri/**` exclude alone, because
  // `outputFileTracingIncludes` OVERRIDES excludes and its globs are
  // substring-matched just like theirs.
  //
  // The include `./src/lib/db/schema.sql` therefore also matches
  // `src-tauri/target/debug/minder-server/src/lib/db/schema.sql` — a staged
  // copy of a previous payload that `tauri build` leaves in `target/`. Measured
  // after a local `pnpm tray:build`: 8 such files, nested up to two payloads
  // deep, pulled back into the payload past their own exclusion. Anchoring the
  // rule at the payload root is the only place that can express "this tree,
  // never a path that merely looks like it". (#417.)
  "src-tauri",
]);

// The repo's own source tree, pruned at the payload root — EXCEPT the SQL
// schemas the runtime reads.
//
// This lives here rather than in next.config.ts's `outputFileTracingExcludes`
// for the same reason `.cache` does, and the cost of getting it wrong was
// measured rather than guessed. A tracer glob `./src/**` is a picomatch
// substring match, so it also hit `node_modules/<pkg>/src/**`. Three packages
// in this tree keep their entry point there (`web-push` -> `src/index.js`,
// plus `debug` and `ecdsa-sig-formatter`), and excluding a package's entry
// point stops the tracer discovering anything that package depends on:
// /api/health's traced node_modules count went 373 -> 258, with only 13 of
// those 115 files matching `/src/` directly. (#417, reverting #284's glob.)
//
// Root-anchored, it cannot reach inside node_modules at all. The carve-out is
// explicit because the payload genuinely needs those two files: in a
// standalone build nothing under `.next/` can serve them, so DB init away from
// a checkout resolves against exactly these.
//
// Paths are compared lower-cased, so these must be written lower-cased —
// `tasksDb` is spelled `tasksdb` here on purpose, not by mistake.
// Everything gitignored at the REPO root, derived rather than restated (#417).
//
// The payload mirrors the repo root — that is the whole of #284 — so a
// root-level name that is developer state in the checkout is developer state in
// the payload. Deriving it is what stops this list drifting one review round at
// a time; the static sets above stay because they also cover names at ANY depth
// (`.claude`, `.git`) and patterns git cannot express as a root entry (`*.pem`).
//
// Root-anchored ONLY. Nothing here reaches the tracer, because these globs
// cannot be anchored and a derived name like `.cache` or `screenshots` would
// then match inside `node_modules`. See gitignored-roots.mjs for the measured
// cost of getting that wrong.
//
// `null` from the derivation means git could not answer (a source-tarball
// build). That degrades to exactly the pre-#417 behaviour — the static rules
// still apply — rather than silently widening what may ship. Callers that want
// to say so in a log line can read `DERIVATION_AVAILABLE`.
const derivedRootIgnored = rootLevelGitignoredEntries();
export const DERIVATION_AVAILABLE = derivedRootIgnored !== null;

// Both the raw name and its separator-normalized form.
//
// `isForbiddenRootRelative` converts the payload path's `\` to `/` before
// looking it up, because on Windows that is what `path.relative` produces. On
// POSIX a filename may legally CONTAIN a backslash, and `git ls-files -z`
// returns such a name verbatim — so a derived `ignored\name` would be compared
// against a normalized `ignored/name` and never match, and the artifact ships
// (Codex, PR #540). Storing both forms closes that without weakening the
// Windows path handling everything else depends on.
export const DERIVED_ROOT_IGNORED = new Set(
  (derivedRootIgnored ?? []).flatMap((name) => {
    const lower = name.toLowerCase();
    return [lower, lower.replace(/\\/g, "/")];
  })
);

const PAYLOAD_SRC_PREFIX = "src/";
export const PAYLOAD_SRC_KEEP = new Set([
  "src/lib/db/schema.sql",
  "src/lib/tasksdb/schema.sql",
]);

// Human-readable summary for log lines. DERIVED from the sets above rather
// than written out, because a hand-maintained restatement is exactly the thing
// that drifts: this list grew by six entries in one review round, and a
// summary that quietly kept describing the old set would have made the log
// line a false reassurance. `.env*` is spelled out because it is a prefix rule
// in `isForbiddenName` rather than a set member.
export const FORBIDDEN_SUMMARY = [
  ...FORBIDDEN_EXACT,
  ".env*",
  "*.pem",
  ...FORBIDDEN_ROOT_RELATIVE,
  // Spelled out for the same reason `.env*` is: the repo-`src/` rule is
  // branching logic inside `isForbiddenRootRelative`, not a set member, so
  // nothing above can derive it. Omitting it would leave the hygiene gate's
  // success line claiming to have checked a smaller set than it did — the
  // exact false reassurance this comment block was written to prevent.
  "src/** (except the two schema.sql files)",
  DERIVATION_AVAILABLE
    ? `${DERIVED_ROOT_IGNORED.size} gitignored root entries (derived)`
    : "gitignored root entries (DERIVATION UNAVAILABLE — git could not be queried)",
].join(", ");

// `relPath` is a payload-root-relative path in either separator style.
export function isForbiddenRootRelative(relPath) {
  if (!relPath) return false;
  const rel = relPath.replace(/\\/g, "/").toLowerCase();
  if (FORBIDDEN_ROOT_RELATIVE.has(rel)) return true;
  if (DERIVED_ROOT_IGNORED.has(rel)) return true;
  if (rel !== "src" && !rel.startsWith(PAYLOAD_SRC_PREFIX)) return false;
  // Keep the carved-out files, and keep every directory on the way down to
  // them — pruning `src/` or `src/lib/` wholesale would take the schemas with
  // it before the copy ever reached them.
  if (PAYLOAD_SRC_KEEP.has(rel)) return false;
  for (const keep of PAYLOAD_SRC_KEEP) {
    if (keep.startsWith(rel + "/")) return false;
  }
  return true;
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
//
// `*.pem` is a SUFFIX rule and the only one here justified primarily by blast
// radius rather than by frequency. `.gitignore:12` ignores it repo-wide
// because a PEM in this checkout is a private signing or TLS key; the
// whole-project tracing fallback (#284) would sweep a root-level one into
// `.next/standalone` and, from there, into a signed installer. Nothing else
// in this module protects it — the rest are exact basenames.
//
// Verified safe to apply broadly in this tree: zero `.pem` files exist under
// `node_modules`, so no dependency is pruned today. The residual risk is a
// future package shipping a CA bundle as `.pem`, which the packager would
// prune silently. That trade is taken deliberately and on the same terms as
// `.env*` above: a private key reaching an installer is not recoverable,
// whereas a missing CA bundle fails loudly at the first TLS call. If a real
// payload file ever legitimately ends in `.pem`, surface it rather than
// silently special-casing.
export function isForbiddenName(name) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_EXACT.has(lower)) return true;
  if (lower.startsWith(".env")) return true;
  if (lower.endsWith(".pem")) return true;
  return false;
}
