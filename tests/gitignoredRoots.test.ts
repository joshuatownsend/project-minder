/**
 * #417: the payload exclusion list is derived from git rather than restated by
 * hand. These tests build a throwaway repository with known ignored entries and
 * run the derivation against THAT.
 *
 * The first version of this suite asserted against the real checkout —
 * `expect(DERIVED_ROOT_IGNORED.has("screenshots")).toBe(true)` — and passed
 * locally for the worst possible reason: those files happened to exist on the
 * author's machine. CI runs from a clean clone where they do not, so
 * `git ls-files --others --ignored` never listed them and the suite went red
 * (Codex, PR #540). A test whose subject is "what git reports about a tree" has
 * to own the tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootLevelGitignoredEntries, BUILD_INPUTS_KEEP } from "../scripts/gitignored-roots.mjs";

/** Is git usable at all? The derivation is allowed to have no answer. */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();
const IGNORED_DIR = "screenshots";
const IGNORED_FILE = "SNIPPET.md";
const TRACKED_FILE = "kept.txt";
const NON_ASCII = "unicodé.png";

let repo: string;

beforeAll(() => {
  if (!HAS_GIT) return;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gitignored-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  git("init");
  // A commit is not required for `ls-files --others`, but identity is set so a
  // machine with no global git config cannot make this suite fail for an
  // unrelated reason.
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");

  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    [IGNORED_DIR + "/", IGNORED_FILE, NON_ASCII, "node_modules/", ".next/", "dist/", ""].join("\n")
  );
  fs.mkdirSync(path.join(repo, IGNORED_DIR));
  fs.writeFileSync(path.join(repo, IGNORED_DIR, "a.png"), "x");
  fs.writeFileSync(path.join(repo, IGNORED_FILE), "x");
  fs.writeFileSync(path.join(repo, NON_ASCII), "x");
  fs.writeFileSync(path.join(repo, TRACKED_FILE), "x");
  // The build inputs the keep-list must protect — all three are gitignored, and
  // a derivation that pruned them would ship a payload that cannot boot.
  for (const keep of ["node_modules", ".next", "dist"]) {
    fs.mkdirSync(path.join(repo, keep));
    fs.writeFileSync(path.join(repo, keep, "x"), "x");
  }
  // Nested ignored content, to prove the derivation stays at the root.
  fs.mkdirSync(path.join(repo, "docs"));
  fs.mkdirSync(path.join(repo, "docs", IGNORED_DIR));
  fs.writeFileSync(path.join(repo, "docs", IGNORED_DIR, "b.png"), "x");
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!HAS_GIT)("rootLevelGitignoredEntries", () => {
  it("derives the ignored root entries, and only those", () => {
    const entries = rootLevelGitignoredEntries(repo);
    expect(entries).not.toBeNull();
    expect(entries).toContain(IGNORED_DIR);
    expect(entries).toContain(IGNORED_FILE);
    // A tracked file is not developer state.
    expect(entries).not.toContain(TRACKED_FILE);
    expect(entries).not.toContain(".gitignore");
  });

  it("never derives away a build input", () => {
    // The catastrophic direction, and the reason the keep-list is an explicit
    // literal: node_modules, .next and dist are all gitignored, so the naive
    // derivation prunes every dependency out of the payload (#417 says so).
    const entries = rootLevelGitignoredEntries(repo)!;
    for (const keep of BUILD_INPUTS_KEEP) {
      expect(entries).not.toContain(keep);
    }
    expect(BUILD_INPUTS_KEEP.has("node_modules")).toBe(true);
  });

  it("stays at the root and drops the trailing slash on directories", () => {
    const entries = rootLevelGitignoredEntries(repo)!;
    // `docs/screenshots` is ignored too, but the payload rule is root-anchored,
    // so a nested path could never match it — including it would only invite
    // the basename confusion the anchoring exists to avoid.
    expect(entries.some((e) => e.includes("/"))).toBe(false);
    expect(entries).toContain(IGNORED_DIR);
    expect(entries).not.toContain(`${IGNORED_DIR}/`);
  });

  it("returns a non-ASCII name verbatim, not git's quoted form", () => {
    // Without `-z`, git quotes it as the literal `"unicod\303\251"`, and the
    // derived rule then matches nothing — so the ignored artifact ships.
    const entries = rootLevelGitignoredEntries(repo)!;
    expect(entries).toContain(NON_ASCII);
    expect(entries.some((e) => e.startsWith('"'))).toBe(false);
  });

  it("returns null — not an empty list — outside a git repository", () => {
    // `null` and `[]` must stay distinguishable: `[]` means git says nothing is
    // ignored, `null` means nobody asked. Treating a failed lookup as a clean
    // repo would silently widen what may ship.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "pm-not-a-repo-"));
    try {
      expect(rootLevelGitignoredEntries(notARepo)).toBeNull();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
