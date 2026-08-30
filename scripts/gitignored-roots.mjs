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
const BUILD_INPUTS_KEEP_NAMES = [
  // Build inputs. All three are gitignored, and pruning any of them produces a
  // payload that cannot boot.
  "node_modules", // the payload's dependencies
  ".next", // the build output the payload is made of
  "dist", // the payload's own tree; `dist/node` has its own narrower rule
  // Payload-root entries the server needs. None is gitignored in this repo
  // today, so these are pure insurance — but the derivation maps REPO-root
  // names onto PAYLOAD-root paths, and the payload root holds `server.js`,
  // `package.json` and friends. A checkout that ignored one of these for any
  // reason would otherwise prune the artifact's own entry point, and the
  // failure would arrive as a packaging abort with a confusing cause
  // (Codex, PR #540).
  "server.js",
  "package.json",
  "BUILD_INFO.json",
  "public",
  "workers",
  "src",
];

/**
 * Compared case-INSENSITIVELY, because the derived lookup is.
 *
 * On a `core.ignoreCase` checkout git can match the `/node_modules` rule
 * against a directory named `NODE_MODULES` and reports that casing back. An
 * exact-case keep-list misses it, `derivedNameForms` then lower-cases it to
 * `node_modules`, and the packager prunes the payload's entire dependency tree
 * (Codex, PR #540). The two comparisons have to agree, and lower-case is the
 * side everything else in the hygiene rules already uses.
 */
export const BUILD_INPUTS_KEEP = new Set(
  BUILD_INPUTS_KEEP_NAMES.map((name) => name.toLowerCase())
);

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
    // `--others --ignored --directory` lists ignored paths. Directories come
    // back with a trailing slash and are NOT descended into, which is what
    // keeps this to one cheap call instead of a recursive walk over
    // node_modules.
    //
    // `--exclude-per-directory=.gitignore`, deliberately, NOT
    // `--exclude-standard`. The latter also applies `core.excludesFile` — the
    // developer's GLOBAL ignore config — which would make what ships depend on
    // a personal setting. A global rule for a name like `server.js`, plus a
    // scratch file of that name at the repo root, would derive an entry that
    // prunes the payload's own entry point (Codex, PR #540). Release builds
    // must depend on the repository, so only the repository's `.gitignore`
    // files are consulted.
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
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-per-directory=.gitignore",
        "--directory",
        "-z",
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // Node defaults `maxBuffer` to 1 MiB, and a root with enough ignored
        // files exceeds it — reproduced at 15,000 entries / ~1.2 MB. The throw
        // then lands in the catch below and returns `null`, which reads as "no
        // git" and disables EVERY derived exclusion, so the largest trees get
        // the least protection. 64 MiB is roughly 800k entries (Codex, PR #540).
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (err) {
    // Two expected cases stay silent, because they are the reason the fallback
    // exists at all: git is not installed (`ENOENT`), or this is not a git
    // repository (`git` exits 128) — a source-tarball build.
    //
    // Everything else means the derivation was ABLE to run and did not:
    // a dubious-ownership refusal, an unreadable index, an output larger than
    // the buffer. The static rules will not compensate, and the hygiene gate's
    // success line would otherwise report a smaller checked set with no cause
    // given (Codex, PR #540). Those warn.
    // Exit 128 is NOT a synonym for "not a repository". `fatal: detected
    // dubious ownership`, a corrupt index and permission failures all use it
    // too, and those mean the derivation was ABLE to run and did not — the
    // opposite of the case the silent fallback exists for (Codex, PR #540).
    // Only git's own "not a repository" wording distinguishes them, so the
    // stderr is captured and read rather than inferred from the status.
    const code = err?.code;
    const stderr = String(err?.stderr ?? "");
    const notARepository = /not a git repository/i.test(stderr);
    const expected = code === "ENOENT" || (err?.status === 128 && notARepository);
    if (!expected) {
      const detail =
        code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "output exceeded maxBuffer — raise it in scripts/gitignored-roots.mjs"
          : `${code ?? "unknown error"}${err?.status != null ? ` (exit ${err.status})` : ""}` +
            (stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : "");
      console.warn(
        `[gitignored-roots] WARNING: \`git ls-files\` failed: ${detail}. ` +
          "Derived payload exclusions are DISABLED for this build; only the static " +
          "rules apply."
      );
    }
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
    if (BUILD_INPUTS_KEEP.has(normalized.toLowerCase())) continue;
    names.add(normalized);
  }
  return [...names].sort();
}
