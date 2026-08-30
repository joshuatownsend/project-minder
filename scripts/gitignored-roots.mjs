// Derive "gitignored developer state at the repo root" from git, instead of
// restating it by hand (#417).
//
// ## Why this exists
//
// Next's whole-project tracing fallback (#284) sweeps everything under the
// tracing root that isn't explicitly excluded, and the tracer has no notion of
// `.gitignore`. So `next.config.ts`'s `outputFileTracingExcludes` and
// `payload-hygiene-rules.mjs` were both hand-maintained restatements of a file
// that already exists. Over a single review round (PR #414) that list gained
// `.env*`, `.worktrees/`, `.minder.json`, `.cache/`, `.design-fetch`,
// `.codegraph`, `.playwright-mcp`, `.agents` and `.claudelint-cache` — every one
// already declared in `.gitignore`, one of them (`.agents`) already sitting in
// `.next/standalone`. The rule is "gitignored developer state inside the tracing
// root"; the code stated instances.
//
// Measured on this checkout when the derivation was written, the hand list was
// still missing: `CLAUDE_MD_SNIPPET.md`, `capture-new.mjs`, `next-env.d.ts`,
// `screenshots/`, `uiux-review/` and seven stray `t2.1-*.png` files.
//
// ## Why the derivation is only ever ROOT-ANCHORED
//
// The obvious implementation — feed these to `outputFileTracingExcludes` — is
// the dangerous one, and #417 says so explicitly: `node_modules/`, `.next/` and
// `dist/` are all gitignored, so a naive derivation prunes every dependency out
// of the payload. The keep-list below is the guard, and it is small enough to
// audit.
//
// The subtler hazard is that the tracer's globs cannot be anchored. They are
// picomatch substring matches with the leading `./` stripped, so a derived entry
// like `.cache` also matches `node_modules/<pkg>/.cache/`. That is not
// hypothetical: `./.cache/**` was measured dropping the traced `node_modules`
// count on `/api/health` by four files — `@huggingface/transformers/.cache/
// Xenova/all-MiniLM-L6-v2/`, the embedding model, weights included. #417's own
// regression showed the same shape at far greater cost: `./src/**` cost that
// route 115 traced files by pruning `web-push`'s entry point.
//
// So nothing derived here becomes a tracer glob. Every derived entry is enforced
// at the PAYLOAD BOUNDARY, root-anchored, where a name cannot collide with
// anything inside `node_modules` by construction. The hand-maintained tracer
// globs in `next.config.ts` remain, demoted to what they always should have
// been: a build-speed optimisation over names verified not to collide, not the
// mechanism that keeps secrets and developer state out of a release.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");

/**
 * Root-level entries that ARE gitignored but the build genuinely consumes.
 *
 * Getting this wrong is catastrophic rather than merely leaky — pruning
 * `node_modules` produces a payload that cannot boot — which is why it is an
 * explicit literal rather than anything clever. Keep it short enough to read in
 * one glance.
 */
export const BUILD_INPUTS_KEEP = new Set([
  "node_modules", // the payload's dependencies
  ".next", // the build output the payload is made of
  "dist", // the payload's own tree; `dist/node` has its own narrower rule
]);

/**
 * Names of root-level gitignored entries, or `null` when git could not answer.
 *
 * `null` is deliberately distinct from `[]`: an empty list means "git says
 * nothing here is ignored", while `null` means "nobody asked git". Callers must
 * not treat a failed lookup as a clean repo — the static rules stay in force
 * either way, so a `null` degrades to exactly the pre-#417 behaviour rather than
 * silently widening what may ship.
 *
 * Requires git at build time. True in CI and in any checkout, and false for a
 * source-tarball build — hence the fallback rather than a throw.
 */
export function rootLevelGitignoredEntries(root = REPO_ROOT) {
  let out;
  try {
    // `--others --ignored --directory` lists ignored paths; `--exclude-standard`
    // applies the normal ignore files. Directories come back with a trailing
    // slash and are NOT descended into, which is what keeps this to one cheap
    // call instead of a recursive walk over node_modules.
    //
    // `-z` is not optional. Without it git QUOTES any path with non-ASCII or
    // control characters — `unicodé` comes back as the literal
    // `"unicod\303\251"` — and the derived name then matches nothing, so that
    // ignored artifact ships. Newlines and edge whitespace in a filename are
    // mangled by line-splitting for the same reason. NUL-delimited output is
    // git's own answer to this (`git ls-files -h`: "separate paths with the NUL
    // character"), so the bytes arrive exactly as they are on disk.
    out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return null;
  }

  const names = new Set();
  for (const entry of out.split("\0")) {
    // Only the NUL separator is stripped — no trimming. A filename may legally
    // begin or end with a space, and quietly normalising it here would produce a
    // rule that never matches the file it was derived from.
    if (!entry) continue;
    // Root level only. A nested ignored path (`docs/.cache/x`) is somebody
    // else's problem: the payload rule is anchored at the root, so a deeper
    // name could never match it anyway, and including it would only invite the
    // basename confusion this module exists to avoid.
    const normalized = entry.replace(/\/+$/, "");
    if (!normalized || normalized.includes("/")) continue;
    if (BUILD_INPUTS_KEEP.has(normalized)) continue;
    names.add(normalized);
  }
  return [...names].sort();
}
