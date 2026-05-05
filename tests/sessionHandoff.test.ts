import { describe, it, expect } from "vitest";
import {
  extractHandoffFacts,
  scoreCompactionFidelity,
  type HandoffFacts,
} from "@/lib/usage/sessionHandoff";
import type { UsageTurn } from "@/lib/usage/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function turn(
  role: "user" | "assistant",
  overrides: Partial<UsageTurn> = {}
): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
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

function bashTurn(commands: string[]): UsageTurn {
  return turn("assistant", {
    toolCalls: commands.map((cmd) => ({
      name: "Bash",
      arguments: { command: cmd },
    })),
  });
}

function editTurn(files: string[]): UsageTurn {
  return turn("assistant", {
    toolCalls: files.map((f) => ({
      name: "Edit",
      arguments: { file_path: f },
    })),
  });
}

function readTurn(files: string[]): UsageTurn {
  return turn("assistant", {
    toolCalls: files.map((f) => ({
      name: "Read",
      arguments: { file_path: f },
    })),
  });
}

// ─── extractHandoffFacts ──────────────────────────────────────────────────────

describe("extractHandoffFacts", () => {
  it("returns empty facts for an empty turn list", () => {
    const facts = extractHandoffFacts([]);
    expect(facts.filesModified).toHaveLength(0);
    expect(facts.filesRead).toHaveLength(0);
    expect(facts.gitCommits).toHaveLength(0);
    expect(facts.keyCommands).toHaveLength(0);
  });

  it("extracts modified files from Edit tool calls", () => {
    const turns = [editTurn(["src/auth.ts", "src/types.ts"])];
    const facts = extractHandoffFacts(turns);
    expect(facts.filesModified).toContain("src/auth.ts");
    expect(facts.filesModified).toContain("src/types.ts");
  });

  it("extracts read files from Read tool calls", () => {
    const turns = [readTurn(["src/config.ts"])];
    const facts = extractHandoffFacts(turns);
    expect(facts.filesRead).toContain("src/config.ts");
  });

  it("moves a file from filesRead to filesModified if later edited", () => {
    const turns = [
      readTurn(["src/auth.ts"]),
      editTurn(["src/auth.ts"]),
    ];
    const facts = extractHandoffFacts(turns);
    expect(facts.filesModified).toContain("src/auth.ts");
    expect(facts.filesRead).not.toContain("src/auth.ts");
  });

  it("deduplicates modified files", () => {
    const turns = [editTurn(["src/auth.ts"]), editTurn(["src/auth.ts"])];
    const facts = extractHandoffFacts(turns);
    expect(facts.filesModified.filter((f) => f === "src/auth.ts")).toHaveLength(1);
  });

  it("parses git commit with -m flag", () => {
    const turns = [bashTurn(['git commit -m "Fix auth bug"'])];
    const facts = extractHandoffFacts(turns);
    expect(facts.gitCommits).toHaveLength(1);
    expect(facts.gitCommits[0].message).toBe("Fix auth bug");
  });

  it("parses git commit with HEREDOC form", () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nAdd pagination\n\nFixes #123\nEOF\n)"`;
    const turns = [bashTurn([cmd])];
    const facts = extractHandoffFacts(turns);
    expect(facts.gitCommits).toHaveLength(1);
    expect(facts.gitCommits[0].message).toBe("Add pagination");
    expect(facts.gitCommits[0].bodyLines).toContain("Fixes #123");
  });

  it("falls back to unparsed message when commit format is unknown", () => {
    const turns = [bashTurn(["git commit --allow-empty"])];
    const facts = extractHandoffFacts(turns);
    expect(facts.gitCommits).toHaveLength(1);
    expect(facts.gitCommits[0].message).toBe("<commit message unparsed>");
  });

  it("extracts non-trivial key commands", () => {
    const turns = [
      bashTurn([
        "npm run build -- --mode production --output dist/bundle",
        "ls",
        "echo hello",
      ]),
    ];
    const facts = extractHandoffFacts(turns);
    expect(facts.keyCommands.length).toBeGreaterThan(0);
    expect(facts.keyCommands.some((c) => c.includes("npm"))).toBe(true);
  });

  it("does not include trivial commands in keyCommands", () => {
    const turns = [bashTurn(["ls", "echo hello", "cd src", "pwd"])];
    const facts = extractHandoffFacts(turns);
    expect(facts.keyCommands).toHaveLength(0);
  });

  it("captures firstUserPrompt from first user turn", () => {
    const turns = [
      turn("user", { userMessageText: "Fix the login bug" }),
      turn("assistant", { assistantText: "Done" }),
    ];
    const facts = extractHandoffFacts(turns);
    expect(facts.firstUserPrompt).toBe("Fix the login bug");
  });

  it("captures lastAssistantText from last assistant turn with text", () => {
    const turns = [
      turn("user"),
      turn("assistant", { assistantText: "First response" }),
      turn("user"),
      turn("assistant", { assistantText: "Final response" }),
    ];
    const facts = extractHandoffFacts(turns);
    expect(facts.lastAssistantText).toBe("Final response");
  });
});

// ─── scoreCompactionFidelity ──────────────────────────────────────────────────

const baseFacts: HandoffFacts = {
  filesModified: ["src/auth.ts", "src/types.ts"],
  filesRead: ["src/config.ts"],
  gitCommits: [{ message: "Fix authentication bug" }],
  keyCommands: ["npm run build -- --mode production"],
};

describe("scoreCompactionFidelity", () => {
  it("returns score=1 and isLowFidelity=false when factsTotal=0", () => {
    const emptyFacts: HandoffFacts = {
      filesModified: [],
      filesRead: [],
      gitCommits: [],
      keyCommands: [],
    };
    const result = scoreCompactionFidelity(emptyFacts, "some summary");
    expect(result.score).toBe(1);
    expect(result.isLowFidelity).toBe(false);
    expect(result.factsTotal).toBe(0);
  });

  it("scores 0% when no facts are mentioned", () => {
    const summary = "The session worked on various components.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    expect(result.score).toBe(0);
    expect(result.isLowFidelity).toBe(true);
    expect(result.factsMentioned).toBe(0);
  });

  it("scores 100% when all facts are mentioned", () => {
    const summary =
      "Modified auth.ts and types.ts. Read config.ts. " +
      "Committed: Fix authentication bug. Ran npm command.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    expect(result.score).toBe(1);
    expect(result.isLowFidelity).toBe(false);
    expect(result.factsMentioned).toBe(result.factsTotal);
  });

  it("computes partial score correctly", () => {
    // Only auth.ts is mentioned out of all facts
    const summary = "Edited auth.ts file to fix the issue.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
    expect(result.factsMentioned).toBeGreaterThan(0);
  });

  it("flags isLowFidelity=true when score < 0.6", () => {
    // Single fact mentioned out of many → score well below 0.6
    const summary = "Touched auth.ts only.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    if (result.factsTotal > 2) {
      expect(result.isLowFidelity).toBe(true);
    }
  });

  it("returns isLowFidelity=false when score >= 0.6", () => {
    const manyFacts: HandoffFacts = {
      filesModified: ["auth.ts", "config.ts", "types.ts"],
      filesRead: [],
      gitCommits: [],
      keyCommands: [],
    };
    // Mention all three files
    const summary = "Modified auth.ts, config.ts, and types.ts.";
    const result = scoreCompactionFidelity(manyFacts, summary);
    expect(result.isLowFidelity).toBe(false);
  });

  it("populates missingFacts with omitted items (capped at 10)", () => {
    const summary = "No details mentioned here at all.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    expect(result.missingFacts.length).toBeGreaterThan(0);
    expect(result.missingFacts.length).toBeLessThanOrEqual(10);
  });

  it("stores the raw summary on the result", () => {
    const summary = "The LLM compaction summary text.";
    const result = scoreCompactionFidelity(baseFacts, summary);
    expect(result.summary).toBe(summary);
  });
});
