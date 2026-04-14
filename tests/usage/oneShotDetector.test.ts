import { describe, it, expect } from "vitest";
import { detectOneShot } from "@/lib/usage/oneShotDetector";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";

// Helper to build a minimal UsageTurn with sensible defaults
function makeTurn(overrides: Partial<UsageTurn> & { role: "user" | "assistant" }): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "session-1",
    projectSlug: "my-project",
    projectDirName: "my-project",
    model: "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

function editTurn(): UsageTurn {
  return makeTurn({
    role: "assistant",
    toolCalls: [{ name: "Edit", arguments: { file_path: "foo.ts", old_string: "a", new_string: "b" } }],
  });
}

function bashTestTurn(command = "npm test"): UsageTurn {
  return makeTurn({
    role: "assistant",
    toolCalls: [{ name: "Bash", arguments: { command } }],
  });
}

function resultTurn(toolResultText: string): UsageTurn {
  return makeTurn({ role: "user", toolResultText });
}

function assistantNoEdit(): UsageTurn {
  return makeTurn({
    role: "assistant",
    toolCalls: [{ name: "Bash", arguments: { command: "echo done" } }],
  });
}

describe("detectOneShot", () => {
  it("returns zero stats for empty turns array", () => {
    const result = detectOneShot([]);
    expect(result).toEqual({ totalVerifiedTasks: 0, oneShotTasks: 0, rate: 0 });
  });

  it("one-shot success: edit → bash(test) → clean result → no re-edit → rate 1.0", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      bashTestTurn("npm test"),
      resultTurn("All tests passed."),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(1);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(1.0);
  });

  it("failed attempt (retry): edit → bash(test) → FAIL result → re-edit → rate 0.0", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      bashTestTurn("npm test"),
      resultTurn("FAIL src/lib/foo.test.ts"),
      editTurn(),                        // assistant re-edits
      bashTestTurn("npm test"),
      resultTurn("All tests passed."),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(2);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(0.5);
  });

  it("no verification step: edit then no bash test → totalVerifiedTasks = 0, rate = 0", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      makeTurn({ role: "user", toolResultText: "ok" }),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(0);
    expect(result.oneShotTasks).toBe(0);
    expect(result.rate).toBe(0);
  });

  it("multiple tasks, mixed results → rate 0.5", () => {
    const turns: UsageTurn[] = [
      // Task 1: succeeds
      editTurn(),
      bashTestTurn("vitest"),
      resultTurn("✓ all tests pass"),
      assistantNoEdit(),
      // Task 2: fails (re-edits)
      editTurn(),
      bashTestTurn("vitest"),
      resultTurn("Error: Cannot find module"),
      editTurn(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(2);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(0.5);
  });

  describe("error pattern detection", () => {
    const errorCases: [string, string][] = [
      ["FAIL", "FAIL src/components/Foo.test.tsx"],
      ["Error:", "Error: Cannot read property of undefined"],
      ["TypeError", "TypeError: undefined is not a function"],
      ["SyntaxError", "SyntaxError: Unexpected token '}'"],
      ["exit code 1", "Process exited with exit code 1"],
      ["exit code 2", "exit code 2 — build failed"],
      ["ERROR", "ERROR in webpack compilation"],
      ["failed", "2 tests failed"],
    ];

    for (const [label, resultText] of errorCases) {
      it(`detects error pattern: "${label}"`, () => {
        const turns: UsageTurn[] = [
          editTurn(),
          bashTestTurn("npm test"),
          resultTurn(resultText),
          assistantNoEdit(),
        ];
        const result = detectOneShot(turns);
        expect(result.totalVerifiedTasks).toBe(1);
        expect(result.oneShotTasks).toBe(0);
        expect(result.rate).toBe(0);
      });
    }
  });

  it("build command as verification: edit → bash(npm run build) → clean → success", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      bashTestTurn("npm run build"),
      resultTurn("Build complete. No errors."),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(1);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(1.0);
  });

  it("lint command counts as verification", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      bashTestTurn("eslint src/"),
      resultTurn("No lint errors found."),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(1);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(1.0);
  });

  it("bash with non-test command does not count as verification", () => {
    const turns: UsageTurn[] = [
      editTurn(),
      makeTurn({ role: "assistant", toolCalls: [{ name: "Bash", arguments: { command: "git status" } }] }),
      resultTurn("nothing to commit"),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(0);
    expect(result.rate).toBe(0);
  });

  it("verification and edit on same assistant turn counts as verified task", () => {
    // If the assistant does both Edit and Bash(test) in one turn, it should still be evaluated
    const combinedTurn = makeTurn({
      role: "assistant",
      toolCalls: [
        { name: "Edit", arguments: { file_path: "foo.ts", old_string: "a", new_string: "b" } },
        { name: "Bash", arguments: { command: "npm test" } },
      ],
    });
    const turns: UsageTurn[] = [
      combinedTurn,
      resultTurn("All tests passed."),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(1);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(1.0);
  });

  it("Write tool call triggers task detection same as Edit", () => {
    const writeTurn = makeTurn({
      role: "assistant",
      toolCalls: [{ name: "Write", arguments: { file_path: "new-file.ts", content: "export {}" } }],
    });
    const turns: UsageTurn[] = [
      writeTurn,
      bashTestTurn("tsc --noEmit"),
      resultTurn(""),
      assistantNoEdit(),
    ];
    const result = detectOneShot(turns);
    expect(result.totalVerifiedTasks).toBe(1);
    expect(result.oneShotTasks).toBe(1);
    expect(result.rate).toBe(1.0);
  });
});
