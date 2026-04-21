import { describe, it, expect } from "vitest";
import { canonicalizeDirName } from "@/lib/usage/parser";

describe("canonicalizeDirName", () => {
  it("leaves a normal project path unchanged", () => {
    expect(canonicalizeDirName("C--dev-project-minder")).toBe("C--dev-project-minder");
  });

  it("strips .worktrees suffix", () => {
    expect(canonicalizeDirName("C--dev-project-minder--worktrees-c9watch")).toBe(
      "C--dev-project-minder"
    );
  });

  it("strips .claude-worktrees suffix (patchmaven convention)", () => {
    expect(
      canonicalizeDirName("C--dev-patchmaven--claude-worktrees-additional-blocks")
    ).toBe("C--dev-patchmaven");
  });

  it("strips .claude-worktrees with hyphenated branch name", () => {
    expect(
      canonicalizeDirName("C--dev-patchmaven--claude-worktrees-feature-timeline-replay")
    ).toBe("C--dev-patchmaven");
  });

  it("does not strip a project named worktrees-something", () => {
    // 'C--dev-worktrees-manager' has no second '--', so no stripping
    expect(canonicalizeDirName("C--dev-worktrees-manager")).toBe("C--dev-worktrees-manager");
  });

  it("strips worktree suffix when an earlier dot-prefixed dir is in the path", () => {
    // Path: C:\dev\project\.cache\.worktrees\branch — two dot-prefixed components
    expect(
      canonicalizeDirName("C--dev-project--cache--worktrees-branch")
    ).toBe("C--dev-project--cache");
  });

  it("strips at the first worktree marker (leaves intermediate dot dirs intact)", () => {
    expect(
      canonicalizeDirName("C--dev-project--cache--claude-worktrees-feature")
    ).toBe("C--dev-project--cache");
  });

  it("stops at first worktree marker even if branch name contains '--worktrees-'", () => {
    // Branch name 'feat--worktrees-fix' is a valid git ref; must not be treated as a second marker
    expect(
      canonicalizeDirName("C--dev-proj--claude-worktrees-feat--worktrees-fix")
    ).toBe("C--dev-proj");
  });

  it("handles Unix-style paths with .worktrees", () => {
    expect(canonicalizeDirName("-home-user-project--worktrees-branch")).toBe(
      "-home-user-project"
    );
  });

  it("handles Unix-style paths with .claude-worktrees", () => {
    expect(canonicalizeDirName("-home-user-project--claude-worktrees-feat")).toBe(
      "-home-user-project"
    );
  });

  it("returns unchanged for unrecognized format", () => {
    expect(canonicalizeDirName("some-random-thing")).toBe("some-random-thing");
  });
});
