import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  FORBIDDEN_ROOT_RELATIVE,
  isForbiddenName,
  isForbiddenRootRelative,
  FORBIDDEN_SUMMARY,
  DERIVED_ROOT_IGNORED,
  DERIVATION_AVAILABLE,
  derivedNameForms,
} from "../scripts/payload-hygiene-rules.mjs";

// These rules decide what can ship inside an installer, so the tests are
// written as "what must never leak" rather than as coverage of the branches.

describe("isForbiddenName", () => {
  it("catches the entries that actually shipped once (issue #284)", () => {
    expect(isForbiddenName(".git")).toBe(true);
    expect(isForbiddenName(".claude")).toBe(true);
    expect(isForbiddenName(".mcp.json")).toBe(true);
    expect(isForbiddenName("agentlytics-repo")).toBe(true);
  });

  it("catches a nested git-worktree checkout", () => {
    // `.worktrees/` is this repo's own supported worktree location and is
    // gitignored, so a checkout with a live worktree there holds a second
    // full copy of the source tree inside the tracing root — the same shape
    // as `agentlytics-repo`, which the #284 tracing fallback already swept.
    // Added before it shipped rather than after (Codex review, PR #414).
    expect(isForbiddenName(".worktrees")).toBe(true);
    expect(isForbiddenName(".WORKTREES")).toBe(true);
    // Not a prefix rule: only the directory itself is forbidden.
    expect(isForbiddenName(".worktrees-backup")).toBe(false);
  });

  it("catches generated developer-state directories", () => {
    // All gitignored, all in the tracing root. `.agents` was the one actually
    // observed inside `.next/standalone`; the rest are the same shape and were
    // added together rather than one review round at a time (Codex, PR #414).
    for (const name of [
      ".design-fetch",
      ".codegraph",
      ".playwright-mcp",
      ".agents",
      ".claudelint-cache",
    ]) {
      expect(isForbiddenName(name)).toBe(true);
    }
    // Basename rules are safe for these only because no package uses the
    // names — unlike `.cache`, which had to be root-anchored.
    expect(isForbiddenName(".agents-sdk")).toBe(false);
  });

  it("catches the developer's own Minder config", () => {
    // `.minder.json` is gitignored and present in any checkout where setup
    // has been run. Shipping it does not merely leak scan roots and project
    // statuses — it SEEDS a fresh install with someone else's config. The
    // runtime resolves its own under `resolveStateDir()`, so a payload copy
    // is never wanted (Codex review, PR #414).
    expect(isForbiddenName(".minder.json")).toBe(true);
    expect(isForbiddenName(".Minder.JSON")).toBe(true);
  });

  // `.env*` is prefix semantics on purpose — the workflow and CHANGELOG both
  // promise `.env*`, not an enumerated list.
  it("treats .env as a prefix, not an exact name", () => {
    expect(isForbiddenName(".env")).toBe(true);
    expect(isForbiddenName(".env.local")).toBe(true);
    expect(isForbiddenName(".env.production")).toBe(true);
    expect(isForbiddenName(".envrc")).toBe(true);
  });

  it("treats .pem as a suffix — a private key must never reach an installer", () => {
    // `.gitignore` ignores *.pem repo-wide because a PEM here is a signing or
    // TLS key. The #284 tracing fallback would sweep a root-level one into
    // .next/standalone and from there into a signed installer, and nothing
    // else in this module catches it — the rest are exact basenames.
    expect(isForbiddenName("server.pem")).toBe(true);
    expect(isForbiddenName("localhost-key.pem")).toBe(true);
    expect(isForbiddenName("KEY.PEM")).toBe(true);
    // Suffix, not substring: a name merely containing "pem" is fine.
    expect(isForbiddenName("pemberton.js")).toBe(false);
    expect(isForbiddenName("pem")).toBe(false);
  });

  it("is case-insensitive (Windows payloads)", () => {
    expect(isForbiddenName(".GIT")).toBe(true);
    expect(isForbiddenName(".Env.Local")).toBe(true);
  });

  it("leaves legitimate payload entries alone", () => {
    expect(isForbiddenName("node_modules")).toBe(false);
    expect(isForbiddenName("server.js")).toBe(false);
    expect(isForbiddenName("environment.js")).toBe(false);
  });
});

describe("isForbiddenRootRelative", () => {
  it("rejects the bundled Node runtime at the payload root", () => {
    expect(isForbiddenRootRelative("dist/node")).toBe(true);
  });

  it("accepts Windows separators, since the packager builds paths with them", () => {
    expect(isForbiddenRootRelative("dist\\node")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isForbiddenRootRelative("Dist/Node")).toBe(true);
  });

  // The whole reason this rule is root-anchored instead of a basename entry in
  // FORBIDDEN_EXACT: `node` is a common directory name, and banning it at any
  // depth would strip real dependencies out of the payload — a far worse
  // failure than the duplication it set out to prevent.
  it("does not match a `node` directory anywhere else in the payload", () => {
    expect(isForbiddenRootRelative("node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/.bin/node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/some-pkg/node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/next/dist/node")).toBe(false);
  });

  it("rejects the checkout's own .cache but not a package's", () => {
    // Despite the name this is not disposable build output: claudeStatsCache
    // writes .cache/claude-stats.json keyed by ABSOLUTE transcript paths with
    // per-file token/tool/model/error counts, and resolveStateDir() falls back
    // to the checkout root in development (Codex review, PR #414).
    expect(isForbiddenRootRelative(".cache")).toBe(true);
    expect(isForbiddenRootRelative(".Cache")).toBe(true);
    // Root-anchored, not a basename rule — `node_modules/<pkg>/.cache/` is an
    // ordinary build-cache location and pruning it would strip real packages.
    expect(isForbiddenName(".cache")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/some-pkg/.cache")).toBe(false);
    expect(isForbiddenRootRelative(".cache/claude-stats.json")).toBe(false);
  });

  // #417: the list is derived from git rather than restated by hand.
  //
  // Asserted WITHOUT naming any particular file. An earlier version of this
  // test expected `screenshots` and `uiux-review` to be derived, which held on
  // the author's machine and failed in CI, where a clean clone has no such
  // untracked files (Codex, PR #540). What is testable here is the wiring;
  // what git reports about a tree is tested in `gitignoredRoots.test.ts`
  // against a repository that suite builds and owns.
  it("forbids whatever the derivation reports", () => {
    for (const entry of DERIVED_ROOT_IGNORED) {
      expect(isForbiddenRootRelative(entry)).toBe(true);
    }
  });

  it("folds derived names on Windows and keeps them verbatim on POSIX", () => {
    // Both directions were learned the hard way (Codex, PR #540).
    //
    // Windows: payload paths arrive from `path.relative` with `\`
    // separators and the filesystem is case-insensitive, so a derived name has
    // to be folded to be findable. Neither fold can lose anything there — no
    // filename may contain a backslash, and two names differing only by case
    // cannot coexist.
    //
    // POSIX: both folds destroy information.
    //   case — `Foo` (tracked, needed) and `foo` (ignored) are DIFFERENT
    //          entries; lower-casing the derived `foo` prunes the tracked `Foo`.
    //   separators — a backslash is a legal filename character, so mapping it
    //          to `/` turns a ROOT rule into one matching a NESTED path.
    if (path.sep === "\\") {
      expect(derivedNameForms("odd\\name.txt")).toEqual([
        "odd\\name.txt",
        "odd/name.txt",
      ]);
      expect(derivedNameForms("SCREENSHOTS")).toEqual(["screenshots"]);
    } else {
      // Verbatim: no separator mapping...
      expect(derivedNameForms("odd\\name.txt")).toEqual(["odd\\name.txt"]);
      expect(derivedNameForms("node_modules\\next")).not.toContain(
        "node_modules/next"
      );
      // ...and no case folding, which would let an ignored `foo` prune a
      // tracked `Foo` and break a payload built from a valid repository.
      expect(derivedNameForms("Foo")).toEqual(["Foo"]);
      expect(derivedNameForms("Foo")).not.toContain("foo");
    }

    // True on every platform: an ordinary name yields exactly one key.
    expect(derivedNameForms("screenshots")).toEqual(["screenshots"]);
  });

  it("never lets a derived name prune a required payload entry", () => {
    // The derivation maps REPO-root names onto PAYLOAD-root paths, and the
    // payload root holds server.js, package.json and node_modules. A checkout
    // that ignored one of those — a global ignore rule plus a scratch file was
    // the case raised — would otherwise prune the artifact's own entry point.
    for (const required of ["server.js", "package.json", "node_modules", ".next"]) {
      expect(isForbiddenRootRelative(required)).toBe(false);
    }
  });

  it("never derives away a build input", () => {
    // The catastrophic direction. node_modules, .next and dist are all
    // gitignored; a naive derivation prunes every dependency out of the payload
    // and ships something that cannot boot (#417 names this explicitly).
    //
    // Holds in both worlds: with git, the keep-list filters them out; without
    // it, the derived set is empty. Neither may make them forbidden.
    for (const keep of ["node_modules", ".next", "dist"]) {
      expect(DERIVED_ROOT_IGNORED.has(keep)).toBe(false);
      expect(isForbiddenRootRelative(keep)).toBe(false);
    }
  });

  it("degrades to the static rules when git cannot answer", () => {
    // `DERIVATION_AVAILABLE` is intentionally allowed to be false — a
    // source-tarball build, or a runner without git (Copilot, PR #540). The
    // static rules must still hold either way, so this asserts the fallback
    // rather than the presence of git.
    expect(typeof DERIVATION_AVAILABLE).toBe("boolean");
    if (!DERIVATION_AVAILABLE) {
      expect(DERIVED_ROOT_IGNORED.size).toBe(0);
    }
    expect(isForbiddenName(".git")).toBe(true);
    expect(isForbiddenRootRelative(".cache")).toBe(true);
  });

  it("keeps derived entries root-anchored, never a substring rule", () => {
    // Why nothing derived is allowed near the tracer. Its globs are picomatch
    // substring matches, so a derived `.cache` also matches
    // `node_modules/@huggingface/transformers/.cache/` — measured dropping the
    // embedding model, weights included. Root-anchoring makes the collision
    // impossible rather than merely unlikely.
    //
    // These hold whether or not the names are derived on this checkout: a
    // NESTED path must never be forbidden, which is the property under test.
    expect(isForbiddenRootRelative("node_modules/some-pkg/screenshots")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/some-pkg/.cache")).toBe(false);
    expect(isForbiddenRootRelative("docs/screenshots")).toBe(false);
    expect(isForbiddenName("screenshots")).toBe(false);
  });

  it("names every rule in the summary the hygiene gate logs", () => {
    // The gate prints FORBIDDEN_SUMMARY on success. A summary narrower than the
    // rules is a log line that overstates what was checked, so each rule that
    // cannot be derived from the sets is asserted here explicitly.
    for (const rule of [
      ".git",
      ".env*",
      "*.pem",
      "dist/node",
      ".cache",
      "src-tauri",
      "src/** (except the two schema.sql files)",
    ]) {
      expect(FORBIDDEN_SUMMARY).toContain(rule);
    }
  });

  it("prunes src-tauri, which the include glob can otherwise drag back in", () => {
    // `outputFileTracingIncludes` overrides excludes AND is substring-matched,
    // so `./src/lib/db/schema.sql` also matches the staged payload copies that
    // `tauri build` leaves under `src-tauri/target/`. Root-anchoring is what
    // stops a path that merely resembles the include from qualifying.
    expect(isForbiddenRootRelative("src-tauri")).toBe(true);
    expect(isForbiddenRootRelative("SRC-TAURI")).toBe(true);
    expect(isForbiddenRootRelative("src-tauri\\target")).toBe(false);

    // Not a basename rule, and not confusable with the repo's own `src/`.
    expect(isForbiddenName("src-tauri")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/some-pkg/src-tauri")).toBe(false);
    expect(isForbiddenRootRelative("src-tauri-notes.md")).toBe(false);
  });

  // The repo's own source tree (#417). This rule exists because the tracer
  // glob that used to do the job could not be anchored: `./src/**` was a
  // picomatch substring match, so it also hit `node_modules/<pkg>/src/**` and
  // pruned three packages' entry points out of the trace.
  it("prunes the repo's src/ but never a dependency's", () => {
    expect(isForbiddenRootRelative("src/app/page.tsx")).toBe(true);
    expect(isForbiddenRootRelative("src/components/ui/badge.tsx")).toBe(true);
    expect(isForbiddenRootRelative("src/lib/db/migrations.ts")).toBe(true);

    // The whole point of anchoring. web-push's entry point IS src/index.js;
    // excluding it stopped the tracer discovering everything web-push needs,
    // which cost /api/health 115 traced files.
    expect(isForbiddenRootRelative("node_modules/web-push/src/index.js")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/debug/src/browser.js")).toBe(false);
    expect(
      isForbiddenRootRelative("node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js")
    ).toBe(false);

    // Anchored, not a prefix match on the string.
    expect(isForbiddenRootRelative("srcfoo")).toBe(false);
    expect(isForbiddenRootRelative("workers/src/thing.js")).toBe(false);
  });

  it("carves out the two SQL schemas, and the path down to them", () => {
    // These are read at DB init and, in a standalone build, are reachable by
    // no other path — pruning them ships a payload that cannot initialise.
    expect(isForbiddenRootRelative("src/lib/db/schema.sql")).toBe(false);
    expect(isForbiddenRootRelative("src/lib/tasksDb/schema.sql")).toBe(false);

    // Every ancestor must survive too: pruning a directory stops the copy
    // before it ever reaches the file inside it.
    for (const dir of ["src", "src/lib", "src/lib/db", "src/lib/tasksDb"]) {
      expect(isForbiddenRootRelative(dir)).toBe(false);
    }

    // Siblings of the carve-out are still pruned — the exception is those two
    // files, not the directories that happen to contain them.
    expect(isForbiddenRootRelative("src/lib/db/ingest.ts")).toBe(true);
    expect(isForbiddenRootRelative("src/lib/config.ts")).toBe(true);

    // Case and separator handling, as everywhere else in this module.
    expect(isForbiddenRootRelative("SRC/LIB/DB/SCHEMA.SQL")).toBe(false);
    expect(isForbiddenRootRelative("src\\lib\\db\\schema.sql")).toBe(false);
    expect(isForbiddenRootRelative("SRC/APP/PAGE.TSX")).toBe(true);
  });

  // A prefix/substring implementation would wrongly claim the real payload
  // subtree is forbidden and prune far more than intended.
  it("matches the directory itself, not paths beneath or beside it", () => {
    expect(isForbiddenRootRelative("dist/node/node.exe")).toBe(false);
    expect(isForbiddenRootRelative("dist/nodes")).toBe(false);
    expect(isForbiddenRootRelative("dist/mcp")).toBe(false);
  });

  it("ignores empty input (the payload root walks as \"\")", () => {
    expect(isForbiddenRootRelative("")).toBe(false);
  });
});

describe("hygiene rule sets", () => {
  // Guards the split itself: moving a root-anchored path into the basename set
  // would silently widen it to every depth, which is the whole reason these
  // are two sets.
  //
  // This deliberately does NOT assert that root-anchored entries contain "/".
  // It used to, back when `dist/node` was the only entry, and that pinned an
  // incidental property of the sample rather than the invariant: `.cache` is a
  // perfectly good single-segment root-anchored rule, and is anchored for
  // exactly the reason this set exists — `node_modules/<pkg>/.cache/` is
  // legitimate, so a basename entry would prune real packages. The rule that
  // actually matters is membership exclusivity, asserted below.
  it("keeps root-anchored paths out of the basename set", () => {
    for (const entry of FORBIDDEN_ROOT_RELATIVE) {
      expect(isForbiddenName(entry)).toBe(false);
    }
  });
});
