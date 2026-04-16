import { describe, it, expect } from "vitest";
import { diffTodos, diffManualSteps, diffInsights } from "@/lib/worktreeSync";

describe("diffTodos", () => {
  it("returns items in worktree not in parent", () => {
    const parent = [{ text: "fix bug", completed: false }];
    const worktree = [{ text: "fix bug", completed: true }, { text: "add feature", completed: false }];
    expect(diffTodos(parent, worktree)).toEqual(["add feature"]);
  });
  it("returns empty when nothing new", () => {
    expect(diffTodos([{ text: "x", completed: false }], [{ text: "x", completed: false }])).toEqual([]);
  });
  it("returns all when parent empty", () => {
    expect(diffTodos([], [{ text: "a", completed: false }, { text: "b", completed: false }])).toEqual(["a", "b"]);
  });
});

describe("diffManualSteps", () => {
  const e = (date: string, slug: string, title: string) => ({ date, featureSlug: slug, title, steps: [] });
  it("returns entries in worktree not in parent", () => {
    const result = diffManualSteps(
      [e("2026-04-01 10:00", "auth", "Setup auth")],
      [e("2026-04-01 10:00", "auth", "Setup auth"), e("2026-04-10 12:00", "feat-x", "Setup X")]
    );
    expect(result).toHaveLength(1);
    expect(result[0].featureSlug).toBe("feat-x");
  });
  it("returns empty when nothing new", () => {
    const entry = e("2026-04-01", "a", "T");
    expect(diffManualSteps([entry], [entry])).toHaveLength(0);
  });
});

describe("diffInsights", () => {
  const ins = (id: string) => ({ id, content: "x", sessionId: "s1", date: "2026-04-01", project: "p", projectPath: "/p" });
  it("returns insights not in parent ids", () => {
    const result = diffInsights(new Set(["abc123"]), [ins("abc123"), ins("def456")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("def456");
  });
  it("returns all when parent empty", () => {
    expect(diffInsights(new Set(), [ins("a"), ins("b")])).toHaveLength(2);
  });
});
