import { describe, it, expect } from "vitest";
import {
  aggregateGroup,
  groupUsageKeys,
  ratio,
  type AggregatableProject,
} from "@/lib/groups/aggregate";
import type { TodoItem, InsightEntry, ManualStepEntry } from "@/lib/types/checklist";
import type { BoardEpic, BoardIssue } from "@/lib/types/board";
import type { OpsRunbookSection } from "@/lib/types/ops";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Small `Partial<T>` builders with spread overrides — the opsSummary.test.ts
// pattern. `member()` builds the read-set, never a whole ProjectData.

const WIN = "C:\\dev\\bamcli";
const OTHER = "D:\\dev\\bamcli";
// A UNC path normalizes to //wsl…, which sorts BEFORE c:/… by codepoint, so a
// WSL member is always first in path order. Used only where a UNC path matters.
const WSL = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\printing-press\\library\\bamcli";

function member(over: Partial<AggregatableProject> & { slug: string; path: string }): AggregatableProject {
  return {
    name: "bamcli",
    status: "active",
    usageSlug: "dev-bamcli",
    scannedAt: "2026-09-01T00:00:00.000Z",
    git: { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl: "https://github.com/joshuatownsend/bamcli" },
    ...over,
  };
}

function todo(text: string, completed = false, lineNumber = 1): TodoItem {
  return { text, completed, lineNumber };
}

function todos(items: TodoItem[]) {
  const completed = items.filter((i) => i.completed).length;
  return { items, total: items.length, completed, pending: items.length - completed };
}

function insight(id: string, over: Partial<InsightEntry> = {}): InsightEntry {
  return { id, content: `insight ${id}`, sessionId: "s1", date: "2026-08-01T00:00:00Z", project: "bamcli", projectPath: WIN, ...over };
}

function insights(entries: InsightEntry[]) {
  return { entries, total: entries.length };
}

function issue(over: Partial<BoardIssue> & { title: string }): BoardIssue {
  return { id: "", status: "todo", labels: [], line: 1, order: 0, ...over };
}

function epic(over: Partial<BoardEpic> & { title: string }): BoardEpic {
  return { id: "", status: "todo", labels: [], line: 1, order: 0, issues: [], ...over };
}

function board(epics: BoardEpic[], inbox: BoardIssue[]) {
  return { epics, inbox, total: epics.length + epics.reduce((n, e) => n + e.issues.length, 0) + inbox.length };
}

function entry(over: Partial<ManualStepEntry> & { title: string }): ManualStepEntry {
  return { date: "2026-07-19 14:30", featureSlug: "signing", steps: [], ...over };
}

function step(text: string, completed = false, lineNumber = 1) {
  return { text, completed, details: [], lineNumber };
}

function manualSteps(entries: ManualStepEntry[]) {
  const all = entries.flatMap((e) => e.steps);
  const completedSteps = all.filter((s) => s.completed).length;
  return { entries, totalSteps: all.length, completedSteps, pendingSteps: all.length - completedSteps };
}

function section(over: Partial<OpsRunbookSection> & { heading: string }): OpsRunbookSection {
  return { key: "backups", body: "", items: [], line: 1, ...over };
}

function opsItem(text: string, done = false) {
  return { text, done, details: [], lineNumber: 1 };
}

function operations(sections: OpsRunbookSection[]) {
  const all = sections.flatMap((s) => s.items);
  return { sections, totalItems: all.length, pendingItems: all.filter((i) => !i.done).length };
}

// ── Group of one ─────────────────────────────────────────────────────────────

describe("aggregateGroup — group of one", () => {
  it("reports its own counts with no divergences", () => {
    const m = member({
      slug: "bamcli",
      path: WIN,
      todos: todos([todo("a"), todo("b", true)]),
      insights: insights([insight("aaa"), insight("bbb")]),
      claude: { sessionCount: 4, lastSessionDate: "2026-08-30T00:00:00Z" },
    });
    const agg = aggregateGroup([m]);
    expect(agg.memberCount).toBe(1);
    expect(agg.primary).toBe("bamcli");
    expect(agg.partial).toBe(false);
    expect(agg.divergences).toEqual([]);
    expect(agg.todos).toMatchObject({ total: 2, completed: 1, pending: 1 });
    expect(agg.insights?.total).toBe(2);
    expect(agg.activity.sessionCount).toBe(4);
    expect(agg.locations).toHaveLength(1);
  });

  it("throws on an empty member list", () => {
    expect(() => aggregateGroup([])).toThrow(/at least one member/);
  });
});

// ── Repo-borne: dedupe, never double-count ──────────────────────────────────

describe("aggregateGroup — repo-borne dedupe", () => {
  it("identical TODO.md in two checkouts counts once, not twice", () => {
    const items = [todo("write tests"), todo("ship it", true)];
    const a = member({ slug: "bamcli", path: WIN, todos: todos(items) });
    const b = member({ slug: "bamcli-library", path: OTHER, todos: todos(items.map((i) => ({ ...i, lineNumber: 99 }))) });
    const agg = aggregateGroup([a, b]);
    expect(agg.todos).toMatchObject({ total: 2, completed: 1, pending: 1 });
    expect(agg.todos?.items.map((i) => i.presentIn)).toEqual([
      ["bamcli", "bamcli-library"],
      ["bamcli", "bamcli-library"],
    ]);
    expect(agg.divergences).toEqual([]);
  });

  it("recomputes counts from the merged set, not by summing member totals", () => {
    // Member totals are deliberately wrong to prove they are never read.
    const a = member({ slug: "a", path: WIN, todos: { items: [todo("x")], total: 50, completed: 50, pending: 0 } });
    const b = member({ slug: "b", path: OTHER, todos: { items: [todo("x"), todo("y")], total: 50, completed: 50, pending: 0 } });
    expect(aggregateGroup([a, b]).todos).toMatchObject({ total: 2, completed: 0, pending: 2 });
  });

  it("keeps two genuinely identical items within one checkout as two items", () => {
    const a = member({ slug: "a", path: WIN, todos: todos([todo("fix flake"), todo("fix flake")]) });
    const b = member({ slug: "b", path: OTHER, todos: todos([todo("fix flake"), todo("fix flake")]) });
    expect(aggregateGroup([a, b]).todos?.total).toBe(2);
  });

  it("normalizes whitespace when keying items", () => {
    const a = member({ slug: "a", path: WIN, todos: todos([todo("  fix   the   thing ")]) });
    const b = member({ slug: "b", path: OTHER, todos: todos([todo("fix the thing")]) });
    expect(aggregateGroup([a, b]).todos?.total).toBe(1);
  });

  it("dedupes insights by id and drops the location-bound project path", () => {
    const a = member({ slug: "a", path: WIN, insights: insights([insight("111"), insight("222")]) });
    const b = member({ slug: "b", path: OTHER, insights: insights([insight("111", { projectPath: OTHER })]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.insights?.total).toBe(2);
    expect(agg.insights?.entries[0]).not.toHaveProperty("projectPath");
    expect(agg.insights?.entries.find((e) => e.id === "222")?.presentIn).toEqual(["a"]);
  });
});

// ── Repo-borne: divergence is surfaced, not resolved ────────────────────────

describe("aggregateGroup — divergence", () => {
  it("flags a file missing from one checkout", () => {
    const a = member({ slug: "a", path: WIN, todos: todos([todo("x")]) });
    const b = member({ slug: "b", path: OTHER });
    const agg = aggregateGroup([a, b]);
    expect(agg.divergences).toEqual([
      { file: "TODO.md", kind: "missing", locations: ["b"], detail: expect.stringContaining("missing in 1 of 2") },
    ]);
    expect(agg.todos?.total).toBe(1);
  });

  it("shows the primary's tick as the headline and records who ticked what", () => {
    const a = member({ slug: "old", path: WIN, lastActivity: "2026-08-01T00:00:00Z", todos: todos([todo("x", true)]) });
    const b = member({ slug: "fresh", path: OTHER, lastActivity: "2026-08-20T00:00:00Z", todos: todos([todo("x", false)]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.primary).toBe("fresh");
    const item = agg.todos!.items[0];
    expect(item.completed).toBe(false);
    expect(item.completedIn).toEqual(["old"]);
    expect(item.presentIn).toEqual(["fresh", "old"]);
    expect(agg.todos).toMatchObject({ completed: 0, pending: 1 });
    expect(agg.divergences).toEqual([
      { file: "TODO.md", kind: "differs", locations: ["fresh", "old"], detail: "1 item ticked differently between locations" },
    ]);
  });

  it("flags items present in only some checkouts", () => {
    const a = member({ slug: "a", path: WIN, todos: todos([todo("shared"), todo("only-a")]) });
    const b = member({ slug: "b", path: OTHER, todos: todos([todo("shared")]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.divergences).toEqual([
      { file: "TODO.md", kind: "differs", locations: ["b"], detail: "1 item not present in every location" },
    ]);
  });

  it("MANUAL_STEPS.md: same checklist, different boxes ticked", () => {
    const a = member({
      slug: "a",
      path: WIN,
      manualSteps: manualSteps([entry({ title: "Keys", steps: [step("gen key", true), step("back it up", false)] })]),
    });
    const b = member({
      slug: "b",
      path: OTHER,
      manualSteps: manualSteps([entry({ title: "Keys", steps: [step("gen key", true), step("back it up", true)] })]),
    });
    const agg = aggregateGroup([a, b]);
    expect(agg.manualSteps?.entries).toHaveLength(1);
    expect(agg.manualSteps?.entries[0].steps.map((s) => s.completedIn)).toEqual([["a", "b"], ["b"]]);
    expect(agg.manualSteps).toMatchObject({ totalSteps: 2, completedSteps: 1, pendingSteps: 1 });
    expect(agg.divergences).toEqual([
      { file: "MANUAL_STEPS.md", kind: "differs", locations: ["a", "b"], detail: "1 step ticked differently between locations" },
    ]);
  });

  it("MANUAL_STEPS.md: an entry archived in one checkout only", () => {
    const shared = entry({ title: "Keys", steps: [step("gen key", true)] });
    const a = member({ slug: "a", path: WIN, manualSteps: manualSteps([shared, entry({ title: "Old", featureSlug: "old", steps: [step("x")] })]) });
    const b = member({ slug: "b", path: OTHER, manualSteps: manualSteps([shared]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.manualSteps?.entries.map((e) => e.presentIn)).toEqual([["a", "b"], ["a"]]);
    expect(agg.divergences).toEqual([
      { file: "MANUAL_STEPS.md", kind: "differs", locations: ["b"], detail: "1 entry not present in every location" },
    ]);
  });

  it("reports scalar facts that differ, with the primary's value as headline", () => {
    const a = member({ slug: "a", path: WIN, lastActivity: "2026-08-20T00:00:00Z", framework: "Next.js", frameworkVersion: "16.3.1" });
    const b = member({ slug: "b", path: OTHER, lastActivity: "2026-08-01T00:00:00Z", framework: "Next.js", frameworkVersion: "16.2.12" });
    const agg = aggregateGroup([a, b]);
    expect(agg.facts.framework).toEqual({ value: "Next.js", valueIn: [{ slug: "a", value: "Next.js" }, { slug: "b", value: "Next.js" }], diverged: false });
    expect(agg.facts.frameworkVersion.value).toBe("16.3.1");
    expect(agg.facts.frameworkVersion.diverged).toBe(true);
    expect(agg.divergences).toEqual([
      { file: "package.json", kind: "differs", locations: ["a", "b"], detail: "frameworkVersion differs between locations: 16.2.12 vs 16.3.1" },
    ]);
  });
});

// ── BOARD.md ─────────────────────────────────────────────────────────────────

describe("aggregateGroup — BOARD.md", () => {
  it("dedupes by surrogate id and records per-location status", () => {
    const a = member({
      slug: "a",
      path: WIN,
      lastActivity: "2026-08-20T00:00:00Z",
      board: board([epic({ id: "e-1", title: "Epic", issues: [issue({ id: "i-1", title: "Do it", status: "doing" })] })], [issue({ id: "i-2", title: "Inbox thing" })]),
    });
    const b = member({
      slug: "b",
      path: OTHER,
      lastActivity: "2026-08-01T00:00:00Z",
      board: board([epic({ id: "e-1", title: "Epic", issues: [issue({ id: "i-1", title: "Do it", status: "done" })] })], [issue({ id: "i-2", title: "Inbox thing" })]),
    });
    const agg = aggregateGroup([a, b]);
    expect(agg.board?.total).toBe(3);
    const merged = agg.board!.epics[0].issues[0];
    expect(merged.status).toBe("doing");
    expect(merged.statusIn).toEqual({ a: "doing", b: "done" });
    expect(agg.divergences).toEqual([
      { file: "BOARD.md", kind: "differs", locations: ["a", "b"], detail: "1 board item with a different status between locations" },
    ]);
  });

  it("falls back to the title when ids are not backfilled, scoped to the container", () => {
    // Same title in the inbox and inside an epic must NOT collapse.
    const a = member({
      slug: "a",
      path: WIN,
      board: board([epic({ title: "Epic", issues: [issue({ title: "Same" })] })], [issue({ title: "Same" })]),
    });
    const b = member({
      slug: "b",
      path: OTHER,
      board: board([epic({ title: "Epic", issues: [issue({ title: "Same" })] })], [issue({ title: "Same" })]),
    });
    const agg = aggregateGroup([a, b]);
    expect(agg.board?.epics).toHaveLength(1);
    expect(agg.board?.epics[0].issues).toHaveLength(1);
    expect(agg.board?.inbox).toHaveLength(1);
    expect(agg.board?.total).toBe(3);
    expect(agg.divergences).toEqual([]);
  });

  it("renumbers order after dedupe", () => {
    const a = member({ slug: "a", path: WIN, board: board([], [issue({ id: "i-1", title: "x", order: 7 }), issue({ id: "i-2", title: "y", order: 9 })]) });
    const b = member({ slug: "b", path: OTHER, board: board([], [issue({ id: "i-2", title: "y", order: 0 }), issue({ id: "i-3", title: "z", order: 1 })]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.board?.inbox.map((i) => [i.id, i.order])).toEqual([["i-1", 0], ["i-2", 1], ["i-3", 2]]);
  });
});

// ── OPERATIONS.md ────────────────────────────────────────────────────────────

describe("aggregateGroup — OPERATIONS.md", () => {
  it("merges sections by key+heading and recomputes pending items", () => {
    const a = member({ slug: "a", path: WIN, operations: operations([section({ heading: "Backups", items: [opsItem("nightly", true), opsItem("offsite")] })]) });
    const b = member({ slug: "b", path: OTHER, operations: operations([section({ heading: "Backups", items: [opsItem("nightly", true), opsItem("offsite")] }), section({ key: "oncall", heading: "On-call", items: [opsItem("rota")] })]) });
    const agg = aggregateGroup([a, b]);
    expect(agg.operations).toMatchObject({ totalItems: 3, pendingItems: 2 });
    expect(agg.operations?.sections.map((s) => s.presentIn)).toEqual([["a", "b"], ["b"]]);
    expect(agg.divergences).toEqual([
      { file: "OPERATIONS.md", kind: "differs", locations: ["a"], detail: "1 section not present in every location" },
    ]);
  });
});

// ── Activity: sum and max ────────────────────────────────────────────────────

describe("aggregateGroup — activity", () => {
  it("sums session counts and carries mostRecent from the newest session's location", () => {
    const a = member({
      slug: "a",
      path: WIN,
      lastActivity: "2026-08-10T00:00:00Z",
      claude: { sessionCount: 3, lastSessionDate: "2026-08-10T00:00:00Z", mostRecentSessionId: "s-a", lastPromptPreview: "old" },
    });
    const b = member({
      slug: "b",
      path: OTHER,
      lastActivity: "2026-08-25T00:00:00Z",
      claude: { sessionCount: 100, lastSessionDate: "2026-08-25T00:00:00Z", mostRecentSessionId: "s-b", lastPromptPreview: "new", mostRecentSessionStatus: "idle" },
    });
    const agg = aggregateGroup([a, b]);
    expect(agg.activity.sessionCount).toBe(103);
    expect(agg.activity.lastSessionDate).toBe("2026-08-25T00:00:00Z");
    expect(agg.activity.lastActivity).toBe("2026-08-25T00:00:00Z");
    expect(agg.activity.mostRecent).toEqual({ slug: "b", sessionId: "s-b", status: "idle", promptPreview: "new" });
    expect(agg.activity.perLocation).toEqual([
      { slug: "a", sessionCount: 3, lastSessionDate: "2026-08-10T00:00:00Z" },
      { slug: "b", sessionCount: 100, lastSessionDate: "2026-08-25T00:00:00Z" },
    ]);
  });

  it("a member with no Claude data contributes zero, not undefined", () => {
    const a = member({ slug: "a", path: WIN, claude: { sessionCount: 2 } });
    const b = member({ slug: "b", path: OTHER });
    expect(aggregateGroup([a, b]).activity.sessionCount).toBe(2);
  });
});

// ── Derived rates ────────────────────────────────────────────────────────────

describe("ratio", () => {
  it("recomputes over summed numerator and denominator, never averages the rates", () => {
    // 1/3 one-shot in a small location, 90/100 in a big one.
    const naiveAverage = (1 / 3 + 90 / 100) / 2;
    const recomputed = ratio(1 + 90, 3 + 100);
    expect(recomputed).toBeCloseTo(91 / 103);
    expect(recomputed).not.toBeCloseTo(naiveAverage, 2);
  });

  it("is undefined on an empty denominator", () => {
    expect(ratio(0, 0)).toBeUndefined();
    expect(ratio(5, 0)).toBeUndefined();
  });
});

// ── Location-bound: never merged ─────────────────────────────────────────────

describe("aggregateGroup — locations", () => {
  it("keeps each checkout's branch, dirty state, port, and worktrees separate", () => {
    const a = member({
      slug: "a",
      path: WIN,
      status: "active",
      devPort: 3000,
      git: { branch: "main", isDirty: true, uncommittedCount: 4 },
      worktrees: [{ branch: "feat/x", worktreePath: "C:\\dev\\bamcli--claude-worktrees-x" }],
    });
    const b = member({
      slug: "b",
      path: OTHER,
      status: "paused",
      git: { branch: "release", isDirty: false, uncommittedCount: 0, unknown: true },
    });
    const agg = aggregateGroup([a, b]);
    expect(agg.locations.map((l) => [l.slug, l.branch, l.isDirty, l.uncommittedCount, l.gitUnknown, l.status, l.devPort])).toEqual([
      ["a", "main", true, 4, false, "active", 3000],
      ["b", "release", false, 0, true, "paused", undefined],
    ]);
    expect(agg.locations[0].worktrees).toEqual([{ branch: "feat/x", worktreePath: "C:\\dev\\bamcli--claude-worktrees-x" }]);
    expect(agg.locations[1].worktrees).toEqual([]);
    // Nothing on the aggregate claims a single branch.
    expect(agg).not.toHaveProperty("branch");
  });

  it("marks members under a skipped root stale and the aggregate partial, regardless of separator style", () => {
    const a = member({ slug: "a", path: WIN });
    const b = member({ slug: "b", path: WSL });
    const agg = aggregateGroup([a, b], {
      skippedRootPaths: ["//wsl.localhost/Ubuntu-26.04/home/josh/printing-press/library/"],
    });
    expect(agg.locations.map((l) => [l.slug, l.stale])).toEqual([["b", true], ["a", false]]);
    expect(agg.partial).toBe(true);
  });

  it("does not treat a sibling root with a shared prefix as skipped", () => {
    const a = member({ slug: "a", path: "C:\\dev\\bamcli" });
    const agg = aggregateGroup([a], { skippedRootPaths: ["C:\\dev\\bam"] });
    expect(agg.locations[0].stale).toBe(false);
    expect(agg.partial).toBe(false);
  });
});

// ── Primary rule and order independence ──────────────────────────────────────

describe("aggregateGroup — primary and determinism", () => {
  it("picks the most recently active member as primary, ties to path order", () => {
    const a = member({ slug: "a", path: "D:\\dev\\x", lastActivity: "2026-08-10T00:00:00Z" });
    const b = member({ slug: "b", path: "C:\\dev\\x", lastActivity: "2026-08-10T00:00:00Z" });
    expect(aggregateGroup([a, b]).primary).toBe("b");
    const c = member({ slug: "c", path: "E:\\dev\\x", lastActivity: "2026-08-11T00:00:00Z" });
    expect(aggregateGroup([a, b, c]).primary).toBe("c");
  });

  it("produces identical output regardless of input order", () => {
    const a = member({
      slug: "a",
      path: WIN,
      lastActivity: "2026-08-20T00:00:00Z",
      todos: todos([todo("x", true), todo("only-a")]),
      insights: insights([insight("111")]),
      board: board([epic({ id: "e-1", title: "E", issues: [issue({ id: "i-1", title: "I", status: "doing" })] })], []),
      claude: { sessionCount: 5, lastSessionDate: "2026-08-20T00:00:00Z" },
    });
    const b = member({
      slug: "b",
      path: OTHER,
      lastActivity: "2026-08-01T00:00:00Z",
      todos: todos([todo("x", false), todo("only-b")]),
      insights: insights([insight("111"), insight("222")]),
      board: board([epic({ id: "e-1", title: "E", issues: [issue({ id: "i-1", title: "I", status: "done" })] })], []),
      claude: { sessionCount: 7, lastSessionDate: "2026-08-01T00:00:00Z" },
    });
    expect(aggregateGroup([b, a])).toEqual(aggregateGroup([a, b]));
  });
});

// ── Usage keys ───────────────────────────────────────────────────────────────

describe("groupUsageKeys", () => {
  it("collapses two local drives that share a usageSlug and keeps a WSL home distinct", () => {
    const c = member({ slug: "c", path: "C:\\dev\\foo", usageSlug: "dev-foo" });
    const d = member({ slug: "d", path: "D:\\dev\\foo", usageSlug: "dev-foo" });
    const w = member({ slug: "w", path: WSL, usageSlug: "dev-foo", usageHomeKey: "wsl:Ubuntu-26.04" });
    expect(groupUsageKeys([w, d, c])).toEqual([
      { usageSlug: "dev-foo", usageHomeKey: "wsl:Ubuntu-26.04" },
      { usageSlug: "dev-foo" },
    ]);
    expect(aggregateGroup([w, d, c]).usageKeys).toHaveLength(2);
  });
});
