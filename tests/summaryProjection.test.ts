/**
 * #496 — the one `SessionSummary` projection, unit-tested directly.
 *
 * **These tests exist because the parity test lost its grip on these fields.**
 * `tests/sessionListAdapters.test.ts` pins the two backends together by running
 * one fixture through both and comparing field by field. That was the whole net
 * while the mapping was duplicated. Now that both call `projectSessionSummary`,
 * the comparison passes for every field this function owns no matter what the
 * function does — shared code agreeing with itself is not evidence of anything.
 *
 * So the parity test keeps its job for the fields that stay split by backend
 * (`costEstimate`, `status`, `isActive`) and for the transition itself, and the
 * branchy rules move here where a wrong answer is actually visible. Each test
 * below covers a branch that has a real other side; the straight renames
 * (`turnCount` -> `messageCount` and friends) are left to the parity test and
 * to typing, because there is no way for them to be subtly rather than
 * obviously wrong.
 */
import { describe, it, expect } from "vitest";
import {
  projectSessionSummary,
  type SessionSummaryProjectionInput,
} from "@/lib/sessions/summaryProjection";
import { projectSlugFromDirName, canonicalizeDirName, toSlug } from "@/lib/sessions/projectIdentity";

function input(
  over: Partial<SessionSummaryProjectionInput> = {}
): SessionSummaryProjectionInput {
  return {
    sessionId: "s-1",
    source: "claude",
    filePath: "C:\\Users\\u\\.claude\\projects\\C--dev-app-x\\s-1.jsonl",
    projectDirName: "C--dev-app-x",
    projectSlug: "dev-app-x",
    startTs: "2026-04-15T10:00:00Z",
    endTs: "2026-04-15T10:05:00Z",
    initialPrompt: "do the thing",
    lastPrompt: "and the other thing",
    turnCount: 4,
    userTurnCount: 2,
    assistantTurnCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreateTokens: 5,
    errorCount: 0,
    verifiedTaskCount: 0,
    oneShotTaskCount: 0,
    cacheHitRatio: null,
    gitBranch: null,
    workModeExplorationPct: null,
    workModeBuildingPct: null,
    workModeTestingPct: null,
    workModeOtherPct: null,
    toolUsage: {},
    skillsUsed: {},
    modelsUsed: [],
    searchableText: undefined,
    ...over,
  };
}

describe("projectSessionSummary (#496)", () => {
  describe("lastPrompt suppression", () => {
    it("drops lastPrompt when it repeats initialPrompt", () => {
      // A single-prompt session would otherwise render the same text twice.
      const s = projectSessionSummary(
        input({ initialPrompt: "only prompt", lastPrompt: "only prompt" })
      );
      expect(s.initialPrompt).toBe("only prompt");
      expect(s.lastPrompt).toBeUndefined();
    });

    it("keeps lastPrompt when it differs", () => {
      // The paired presence assertion. Without it the test above is satisfied
      // by a projection that never sets `lastPrompt` at all.
      const s = projectSessionSummary(input());
      expect(s.lastPrompt).toBe("and the other thing");
    });
  });

  describe("oneShotRate", () => {
    it("is undefined when nothing was verified", () => {
      // NOT 0. "No verified tasks" and "verified tasks, none one-shot" are
      // different facts, and 0 renders the second for both.
      expect(projectSessionSummary(input({ verifiedTaskCount: 0 })).oneShotRate).toBeUndefined();
    });

    it("is 0 when tasks were verified and none was one-shot", () => {
      expect(
        projectSessionSummary(input({ verifiedTaskCount: 4, oneShotTaskCount: 0 })).oneShotRate
      ).toBe(0);
    });

    it("is the ratio otherwise", () => {
      expect(
        projectSessionSummary(input({ verifiedTaskCount: 4, oneShotTaskCount: 3 })).oneShotRate
      ).toBe(0.75);
    });
  });

  describe("workMode is all-or-nothing", () => {
    it("is undefined when any percentage is missing", () => {
      // A partial split renders as a bar that does not sum to 100, which is
      // worse than no bar. Each of the four is checked on its own: a guard
      // written as a single `!== null` on one field passes a test that only
      // ever nulls that one.
      for (const missing of [
        "workModeExplorationPct",
        "workModeBuildingPct",
        "workModeTestingPct",
        "workModeOtherPct",
      ] as const) {
        const s = projectSessionSummary(
          input({
            workModeExplorationPct: 40,
            workModeBuildingPct: 30,
            workModeTestingPct: 20,
            workModeOtherPct: 10,
            [missing]: null,
          })
        );
        expect(s.workMode, `nulling ${missing} should suppress workMode`).toBeUndefined();
      }
    });

    it("is the split when all four are present", () => {
      const s = projectSessionSummary(
        input({
          workModeExplorationPct: 40,
          workModeBuildingPct: 30,
          workModeTestingPct: 20,
          workModeOtherPct: 10,
        })
      );
      expect(s.workMode).toEqual({ exploration: 40, building: 30, testing: 20, other: 10 });
    });

    it("lets a zero split through, because 0 is a measurement and null is not", () => {
      // Pinned as current behaviour rather than endorsed — a user-only session
      // produces this. What matters is that it is decided in ONE place now.
      const s = projectSessionSummary(
        input({
          workModeExplorationPct: 0,
          workModeBuildingPct: 0,
          workModeTestingPct: 0,
          workModeOtherPct: 0,
        })
      );
      expect(s.workMode).toEqual({ exploration: 0, building: 0, testing: 0, other: 0 });
    });
  });

  describe("isWorktree reads two sources", () => {
    it("finds the marker in the file path (the Claude shape)", () => {
      // A Claude transcript lives INSIDE the worktree, and its dir name was
      // canonicalized at ingest, so only the path still carries the marker.
      const s = projectSessionSummary(
        input({
          filePath:
            "C:\\Users\\u\\.claude\\projects\\C--dev-app-x--claude-worktrees-feat\\s-1.jsonl",
          projectDirName: "C--dev-app-x",
        })
      );
      expect(s.isWorktree).toBe(true);
    });

    it("finds the marker in the encoded dir name (the adapter shape)", () => {
      // An adapter transcript lives under the harness's own home, which carries
      // no marker at all — the worktree fact survives only in the encoded cwd.
      const s = projectSessionSummary(
        input({
          source: "codex",
          filePath: "C:\\Users\\u\\.codex\\sessions\\2026\\s-1.jsonl",
          projectDirName: "C--dev-app-x--claude-worktrees-feat",
        })
      );
      expect(s.isWorktree).toBe(true);
    });

    it("is false when neither source carries a marker", () => {
      expect(projectSessionSummary(input()).isWorktree).toBe(false);
    });
  });

  describe("project identity", () => {
    it("canonicalizes the path but keeps projectName raw", () => {
      // The #497 decision, now expressed once. `projectName` feeds the
      // worktree check, so canonicalizing it would silently mark these
      // sessions as non-worktree on BOTH backends at once.
      const s = projectSessionSummary(
        input({
          projectDirName: "C--dev-app-x--claude-worktrees-feat",
          projectSlug: "dev-app-x",
        })
      );
      expect(s.projectName).toBe("C--dev-app-x--claude-worktrees-feat");
      expect(s.projectPath).toBe("C:\\dev\\app\\x");
    });

    it("prefers the stored slug over deriving one", () => {
      // The stored value is authoritative: ingest derives it from the turns'
      // own slug for adapters, which is not always what the dir name alone
      // would produce.
      const s = projectSessionSummary(input({ projectSlug: "stored-slug" }));
      expect(s.projectSlug).toBe("stored-slug");
    });

    it("derives a CANONICAL slug when the stored one is null", () => {
      // The degenerate branch — schema permits NULL, a healthy index never
      // produces it. The DB loader's old inline fallback did not canonicalize,
      // so this branch would have handed back the worktree slug and undone
      // #497 on exactly the rows that fix was for.
      const s = projectSessionSummary(
        input({ projectDirName: "C--dev-app-x--claude-worktrees-feat", projectSlug: null })
      );
      expect(s.projectSlug).toBe("dev-app-x");
    });
  });

  describe("scalars that still need a decision", () => {
    it("computes durationMs only when both ends are known", () => {
      expect(projectSessionSummary(input()).durationMs).toBe(5 * 60_000);
      expect(projectSessionSummary(input({ endTs: null })).durationMs).toBeUndefined();
      expect(projectSessionSummary(input({ startTs: null })).durationMs).toBeUndefined();
    });

    it("counts subagents from the Agent tool tally, defaulting to 0", () => {
      expect(projectSessionSummary(input({ toolUsage: { Agent: 3, Read: 9 } })).subagentCount).toBe(3);
      expect(projectSessionSummary(input({ toolUsage: { Read: 9 } })).subagentCount).toBe(0);
    });

    it("maps nullable scalars to undefined rather than null", () => {
      // `SessionSummary` is a client-facing shape; a null here renders as a
      // present-but-empty field where undefined renders as absent.
      const s = projectSessionSummary(input());
      expect(s.cacheHitRatio).toBeUndefined();
      expect(s.gitBranch).toBeUndefined();
      expect(projectSessionSummary(input({ cacheHitRatio: 0.5 })).cacheHitRatio).toBe(0.5);
      expect(projectSessionSummary(input({ gitBranch: "main" })).gitBranch).toBe("main");
    });

    it("passes errorCount through", () => {
      // Unreachable from any adapter fixture — neither the Codex nor the Gemini
      // parser sets `isError` on a TURN (Gemini sets it per tool CALL, which
      // lands in `tool_uses.is_error` instead), so `errorCount` is 0 on both
      // sides of the parity comparison and that comparison proves nothing about
      // it. Covered here, where a non-zero value can actually be supplied.
      expect(projectSessionSummary(input({ errorCount: 7 })).errorCount).toBe(7);
    });
  });
});

describe("projectIdentity (#496)", () => {
  it("canonicalizes as well as slugifies", () => {
    const WT = "C--dev-app-x--claude-worktrees-feat";
    expect(projectSlugFromDirName(WT)).toBe("dev-app-x");
    expect(projectSlugFromDirName(WT)).toBe(toSlug(canonicalizeDirName(WT)));
    // The failure this guards is dropping the canonicalize step, not writing
    // the two in the wrong order: on every dir-name shape in play the marker
    // survives `toSlug` intact, so both orders agree and an order assertion
    // would pass either way. Forgetting `canonicalizeDirName` altogether is
    // what #497 actually was, and it is visible here.
    expect(toSlug(WT)).toBe("dev-app-x--claude-worktrees-feat");
    expect(projectSlugFromDirName(WT)).not.toBe(toSlug(WT));
  });

  describe("toSlug drops the path prefix, not short segments (#502)", () => {
    it("drops the drive letter and the empty segment its `--` produces", () => {
      expect(toSlug("C--dev-app-x")).toBe("dev-app-x");
      expect(toSlug("c--dev-project-minder")).toBe("dev-project-minder");
    });

    it("drops the leading empty segments of a POSIX or UNC encoding", () => {
      expect(toSlug("-home-user-my-project")).toBe("home-user-my-project");
      expect(toSlug("--wsl-localhost-Ubuntu-26-04-home-josh-dev")).toBe(
        "wsl-localhost-ubuntu-26-04-home-josh-dev",
      );
    });

    it("keeps a one-character path component instead of skipping to it", () => {
      // The old rule scanned for the first segment longer than one character,
      // so it ate real components: `/a/bc` slugged to "bc".
      expect(toSlug("-a-bc")).toBe("a-bc");
    });

    it("keeps every component when they are all one character", () => {
      // The reported defect: `findIndex` returned -1 and `slice(-1)` kept only
      // the last segment, so `C:\a\b` collided with any project slugged "b".
      expect(toSlug("C--a-b")).toBe("a-b");
      expect(toSlug("C--x-y-z")).toBe("x-y-z");
    });

    it("still slugs a single-component degenerate path to that component", () => {
      // This one passed BEFORE the fix too, for the wrong reason — `slice(-1)`
      // on a three-element array happens to yield the element that was wanted.
      // It is here to pin the answer, not to discriminate the fix; the two
      // cases above do that.
      expect(toSlug("C--a")).toBe("a");
    });

    it("lowercases and replaces characters outside [a-z0-9-]", () => {
      expect(toSlug("C--dev-My_App.v2")).toBe("dev-my-app-v2");
    });
  });

  it("is re-exported unchanged from both of its former homes", async () => {
    // Six modules import `canonicalizeDirName` from `usage/parser` and several
    // import `toSlug` from the scanner. Both moved to a leaf and are
    // re-exported; this asserts the re-exports resolve to the same functions
    // rather than to a second copy that drifts.
    const parser = await import("@/lib/usage/parser");
    const scanner = await import("@/lib/scanner/claudeConversations");
    expect(parser.canonicalizeDirName).toBe(canonicalizeDirName);
    expect(scanner.toSlug).toBe(toSlug);
  });
});
