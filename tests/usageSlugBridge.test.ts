import { describe, it, expect } from "vitest";
import { encodePath, toSlug } from "@/lib/scanner/claudeConversations";
import { canonicalizeDirName } from "@/lib/usage/parser";

// The scanner derives `ProjectData.usageSlug` as
//   toSlug(canonicalizeDirName(encodePath(projectPath)))
// so a scanned project can be joined to its usage aggregates (which the usage
// parser keys under `toSlug(canonicalizeDirName(<encoded conversation dir>))`).
// `encodePath(projectPath)` reconstructs that encoded dir, so the two pipelines
// converge. This test pins the derivation and guards against drift if any of
// the three helpers change — a divergence would silently break the cost report's
// row links and the per-project Costs tab.

function usageSlugForPath(projectPath: string): string {
  return toSlug(canonicalizeDirName(encodePath(projectPath)));
}

describe("usageSlug bridge (path → usage projectSlug)", () => {
  it("maps a standard C:\\dev project to its dev-prefixed usage slug", () => {
    expect(usageSlugForPath("C:\\dev\\project-minder")).toBe("dev-project-minder");
    expect(usageSlugForPath("C:\\dev\\pumpops")).toBe("dev-pumpops");
  });

  it("lowercases the drive letter so casing does not fork the slug", () => {
    expect(usageSlugForPath("c:\\dev\\perfect-palette")).toBe(
      usageSlugForPath("C:\\dev\\perfect-palette"),
    );
    expect(usageSlugForPath("c:\\dev\\perfect-palette")).toBe("dev-perfect-palette");
  });

  it("normalizes non-alphanumeric characters in the basename", () => {
    // toSlug's final replace collapses dots/other chars to hyphens.
    expect(usageSlugForPath("C:\\dev\\my.app")).toBe("dev-my-app");
  });

  it("strips Claude worktree suffixes to the parent project slug", () => {
    // canonicalizeDirName drops `--…-worktrees-…`; a worktree path collapses to
    // the parent so per-project usage joins don't fragment per branch.
    const encodedWorktree = "C--dev-project-minder--claude-worktrees-feature";
    expect(toSlug(canonicalizeDirName(encodedWorktree))).toBe("dev-project-minder");
  });
});
