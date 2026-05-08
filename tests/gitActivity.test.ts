import { describe, it, expect } from "vitest";
import { aggregateGitActivity } from "@/lib/usage/gitActivity";

describe("aggregateGitActivity", () => {
  it("counts git commits", () => {
    const result = aggregateGitActivity(
      [{ command: "git commit -m 'feat: add thing'" }],
      []
    );
    expect(result.commits).toBe(1);
    expect(result.pushes).toBe(0);
  });

  it("counts git pushes", () => {
    const result = aggregateGitActivity(
      [{ command: "git push origin main" }],
      []
    );
    expect(result.pushes).toBe(1);
    expect(result.commits).toBe(0);
  });

  it("does NOT count git commit-tree as a commit", () => {
    const result = aggregateGitActivity(
      [{ command: "git commit-tree HEAD^{tree}" }],
      []
    );
    expect(result.commits).toBe(0);
  });

  it("handles both commit and push in one command set", () => {
    const cmds = [
      { command: "git add ." },
      { command: "git commit -m 'update'" },
      { command: "git push" },
      { command: "git push origin feature" },
    ];
    const result = aggregateGitActivity(cmds, []);
    expect(result.commits).toBe(1);
    expect(result.pushes).toBe(2);
  });

  it("builds branch list sorted by recency", () => {
    const branches = [
      { branch: "main", lastActivity: "2026-05-07T10:00:00Z" },
      { branch: "feature", lastActivity: "2026-05-08T12:00:00Z" },
      { branch: "main", lastActivity: "2026-05-06T08:00:00Z" },
    ];
    const result = aggregateGitActivity([], branches);
    expect(result.branches).toHaveLength(2);
    expect(result.branches[0].branch).toBe("feature");
    expect(result.branches[1].branch).toBe("main");
    expect(result.branches[1].sessionCount).toBe(2);
  });

  it("limits branch list to 15 entries", () => {
    const branches = Array.from({ length: 20 }, (_, i) => ({
      branch: `branch-${i}`,
      lastActivity: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const result = aggregateGitActivity([], branches);
    expect(result.branches.length).toBe(15);
  });

  it("ignores null branches", () => {
    const branches = [
      { branch: null, lastActivity: "2026-05-08T10:00:00Z" },
      { branch: "main", lastActivity: "2026-05-08T10:00:00Z" },
    ];
    const result = aggregateGitActivity([], branches);
    expect(result.branches).toHaveLength(1);
  });

  it("returns zeros and empty for empty inputs", () => {
    expect(aggregateGitActivity([], [])).toEqual({ commits: 0, pushes: 0, branches: [] });
  });
});
