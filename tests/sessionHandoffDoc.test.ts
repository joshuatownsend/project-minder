import { describe, it, expect } from "vitest";
import { generateHandoffDoc } from "@/lib/usage/sessionHandoffDoc";
import type { HandoffDocInput } from "@/lib/usage/sessionHandoffDoc";
import type { UsageTurn } from "@/lib/usage/types";

function turn(
  role: "user" | "assistant",
  overrides: Partial<UsageTurn> = {}
): UsageTurn {
  return {
    timestamp: "2026-01-01T12:00:00.000Z",
    sessionId: "sess1",
    projectSlug: "my-project",
    projectDirName: "C--dev-my-project",
    model: "claude-opus-4-5",
    role,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

const baseTurns: UsageTurn[] = [
  turn("user", {
    timestamp: "2026-01-01T12:00:00.000Z",
    userMessageText: "Fix the authentication bug in the login flow",
  }),
  turn("assistant", {
    timestamp: "2026-01-01T12:05:00.000Z",
    assistantText: "I've fixed the authentication bug by updating the token validation.",
    toolCalls: [
      { name: "Edit", arguments: { file_path: "src/auth.ts" } },
      { name: "Bash", arguments: { command: "npm run test -- --filter auth" } },
    ],
  }),
  turn("user", {
    timestamp: "2026-01-01T12:10:00.000Z",
    userMessageText: "Looks good. Can you also update the tests?",
  }),
  turn("assistant", {
    timestamp: "2026-01-01T12:15:00.000Z",
    assistantText: "Updated the test suite to cover the new token validation logic.",
    toolCalls: [
      { name: "Write", arguments: { file_path: "tests/auth.test.ts" } },
    ],
  }),
];

const baseFacts = {
  filesModified: ["src/auth.ts", "tests/auth.test.ts"],
  filesRead: ["src/config.ts"],
  gitCommits: [{ message: "Fix auth token validation" }],
  keyCommands: [
    "npm run test -- --filter auth --coverage --reporter=verbose",
  ],
  firstUserPrompt: "Fix the authentication bug in the login flow",
  lastAssistantText:
    "Updated the test suite to cover the new token validation logic.",
};

function makeInput(
  verbosity: HandoffDocInput["verbosity"],
  overrides: Partial<HandoffDocInput> = {}
): HandoffDocInput {
  return {
    sessionId: "abc123",
    projectName: "my-project",
    facts: baseFacts,
    turns: baseTurns,
    verbosity,
    ...overrides,
  };
}

// ─── All verbosity levels produce valid markdown ──────────────────────────────

describe("generateHandoffDoc", () => {
  it("minimal: includes header, original task, current state, counts", () => {
    const doc = generateHandoffDoc(makeInput("minimal"));
    expect(doc).toContain("# Handoff");
    expect(doc).toContain("abc123");
    expect(doc).toContain("## Original Task");
    expect(doc).toContain("Fix the authentication bug");
    expect(doc).toContain("## Current State");
    expect(doc).toContain("Updated the test suite");
    expect(doc).toContain("## Facts");
    expect(doc).toContain("**Files modified:** 2");
    expect(doc).toContain("**Git commits:** 1");
  });

  it("minimal: does NOT include file lists or conversation tail", () => {
    const doc = generateHandoffDoc(makeInput("minimal"));
    expect(doc).not.toContain("src/auth.ts");
    expect(doc).not.toContain("## Recent Conversation");
  });

  it("standard: includes file lists capped at 25", () => {
    const doc = generateHandoffDoc(makeInput("standard"));
    expect(doc).toContain("### Files Modified");
    expect(doc).toContain("src/auth.ts");
    expect(doc).toContain("### Git Commits");
    expect(doc).toContain("Fix auth token validation");
  });

  it("standard: includes recent conversation tail (last 10 turns)", () => {
    const doc = generateHandoffDoc(makeInput("standard"));
    expect(doc).toContain("## Recent Conversation");
    expect(doc).toContain("**User**:");
    expect(doc).toContain("**Assistant**:");
  });

  it("standard: does NOT include fidelity section", () => {
    const doc = generateHandoffDoc(
      makeInput("standard", {
        fidelity: {
          summary: "some summary",
          factsTotal: 5,
          factsMentioned: 2,
          score: 0.4,
          isLowFidelity: true,
          missingFacts: ["auth.ts"],
        },
      })
    );
    expect(doc).not.toContain("## Compaction Fidelity");
  });

  it("verbose: includes fidelity section when provided", () => {
    const doc = generateHandoffDoc(
      makeInput("verbose", {
        fidelity: {
          summary: "summary text",
          factsTotal: 5,
          factsMentioned: 2,
          score: 0.4,
          isLowFidelity: true,
          missingFacts: ["auth.ts", "types.ts"],
        },
      })
    );
    expect(doc).toContain("## Compaction Fidelity");
    expect(doc).toContain("40%");
    expect(doc).toContain("Low fidelity");
    expect(doc).toContain("auth.ts");
  });

  it("verbose: commit body lines are included", () => {
    const doc = generateHandoffDoc(
      makeInput("verbose", {
        facts: {
          ...baseFacts,
          gitCommits: [
            {
              message: "Add pagination",
              bodyLines: ["Resolves #123", "See also: #456"],
            },
          ],
        },
      })
    );
    expect(doc).toContain("Add pagination");
    expect(doc).toContain("Resolves #123");
  });

  it("full: includes all turns in conversation section", () => {
    const doc = generateHandoffDoc(makeInput("full"));
    expect(doc).toContain("## Recent Conversation");
    // Both user and assistant turns should appear
    expect((doc.match(/\*\*User\*\*:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("full: includes tool breakdown section", () => {
    const doc = generateHandoffDoc(makeInput("full"));
    expect(doc).toContain("## Tool Call Breakdown");
    expect(doc).toContain("**Edit:**");
    expect(doc).toContain("**Write:**");
  });

  it("includes project name in header", () => {
    const doc = generateHandoffDoc(makeInput("minimal"));
    expect(doc).toContain("my-project");
  });

  it("handles missing firstUserPrompt gracefully", () => {
    const doc = generateHandoffDoc(
      makeInput("minimal", {
        facts: { ...baseFacts, firstUserPrompt: undefined },
      })
    );
    expect(doc).toContain("_No user prompt found_");
  });

  it("handles missing lastAssistantText gracefully", () => {
    const doc = generateHandoffDoc(
      makeInput("minimal", {
        facts: { ...baseFacts, lastAssistantText: undefined },
      })
    );
    expect(doc).toContain("_No assistant response found_");
  });
});
