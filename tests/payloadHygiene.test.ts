import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_ROOT_RELATIVE,
  isForbiddenName,
  isForbiddenRootRelative,
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
