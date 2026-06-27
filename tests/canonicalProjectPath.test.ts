import { describe, it, expect } from "vitest";
import path from "path";
import { resolveCanonicalProjectPath } from "../src/lib/canonicalProjectPath";
import { WORKTREE_SEP } from "../src/lib/scanner/worktreeCheck";

// Platform-agnostic fixtures: build paths with path.join so the test passes on
// both Windows (dev) and Linux (CI).
const root = path.resolve("fixtures-dev");
const parent = path.join(root, "crew-leader");
const worktree = path.join(root, `crew-leader${WORKTREE_SEP}feature-x`);

describe("resolveCanonicalProjectPath", () => {
  it("returns a non-worktree dir unchanged", () => {
    expect(resolveCanonicalProjectPath(parent, [root])).toEqual({
      canonicalPath: parent,
      wasWorktree: false,
    });
  });

  it("redirects a worktree dir to its sibling parent inside the dev root", () => {
    expect(resolveCanonicalProjectPath(worktree, [root])).toEqual({
      canonicalPath: parent,
      wasWorktree: true,
      branchHint: "feature-x",
    });
  });

  it("matches the worktree separator case-insensitively", () => {
    const upper = path.join(root, `Crew-Leader${WORKTREE_SEP.toUpperCase()}fix-y`);
    const r = resolveCanonicalProjectPath(upper, [root]);
    expect(r.wasWorktree).toBe(true);
    expect(r.canonicalPath).toBe(path.join(root, "Crew-Leader"));
    expect(r.branchHint).toBe("fix-y");
  });

  it("refuses to redirect when the parent is not inside any dev root", () => {
    const otherRoot = path.resolve("somewhere-else");
    const stray = path.join(otherRoot, `app${WORKTREE_SEP}branch`);
    expect(resolveCanonicalProjectPath(stray, [root])).toEqual({
      canonicalPath: stray,
      wasWorktree: false,
    });
  });

  it("handles an empty branch hint", () => {
    const noHint = path.join(root, `crew-leader${WORKTREE_SEP}`);
    const r = resolveCanonicalProjectPath(noHint, [root]);
    expect(r.wasWorktree).toBe(true);
    expect(r.branchHint).toBeUndefined();
    expect(r.canonicalPath).toBe(parent);
  });
});
