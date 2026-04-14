import { describe, it, expect } from "vitest";
import { classifyTurn } from "@/lib/usage/classifier";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    projectSlug: "test-project",
    projectDirName: "test-project",
    model: "claude-sonnet-4-5",
    role: "user",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

function bashTool(command: string): ToolCall {
  return { name: "Bash", arguments: { command } };
}

describe("classifyTurn", () => {
  it("Git Ops: Bash with git commit", () => {
    const turn = makeTurn({ toolCalls: [bashTool('git commit -m "test"')] });
    expect(classifyTurn(turn)).toBe("Git Ops");
  });

  it("Git Ops: PowerShell with git push", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "PowerShell", arguments: { command: "git push origin main" } }],
    });
    expect(classifyTurn(turn)).toBe("Git Ops");
  });

  it("Build/Deploy: Bash with npm run build", () => {
    const turn = makeTurn({ toolCalls: [bashTool("npm run build")] });
    expect(classifyTurn(turn)).toBe("Build/Deploy");
  });

  it("Build/Deploy: Bash with docker build", () => {
    const turn = makeTurn({ toolCalls: [bashTool("docker build -t myapp .")] });
    expect(classifyTurn(turn)).toBe("Build/Deploy");
  });

  it("Testing: Bash with npm test", () => {
    const turn = makeTurn({ toolCalls: [bashTool("npm test")] });
    expect(classifyTurn(turn)).toBe("Testing");
  });

  it("Testing: Bash with vitest", () => {
    const turn = makeTurn({ toolCalls: [bashTool("npx vitest run")] });
    expect(classifyTurn(turn)).toBe("Testing");
  });

  it("Testing: Edit targeting a test file", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "Edit", arguments: { file_path: "tests/foo.test.ts", old_string: "a", new_string: "b" } }],
    });
    expect(classifyTurn(turn)).toBe("Testing");
  });

  it("Testing: Write targeting a test file", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "Write", arguments: { file_path: "src/__tests__/bar.ts", content: "" } }],
    });
    expect(classifyTurn(turn)).toBe("Testing");
  });

  it("Debugging: user message mentions fix and error", () => {
    const turn = makeTurn({ userMessageText: "fix the error in auth" });
    expect(classifyTurn(turn)).toBe("Debugging");
  });

  it("Debugging: turn with isError: true", () => {
    const turn = makeTurn({ isError: true });
    expect(classifyTurn(turn)).toBe("Debugging");
  });

  it("Debugging: user message mentions crash", () => {
    const turn = makeTurn({ userMessageText: "the app crash on startup" });
    expect(classifyTurn(turn)).toBe("Debugging");
  });

  it("Refactoring: user message mentions refactor", () => {
    const turn = makeTurn({ userMessageText: "refactor the auth module" });
    expect(classifyTurn(turn)).toBe("Refactoring");
  });

  it("Refactoring: user message mentions clean up", () => {
    const turn = makeTurn({ userMessageText: "clean up this component" });
    expect(classifyTurn(turn)).toBe("Refactoring");
  });

  it("Delegation: turn with Agent tool call", () => {
    const turn = makeTurn({ toolCalls: [{ name: "Agent", arguments: {} }] });
    expect(classifyTurn(turn)).toBe("Delegation");
  });

  it("Delegation: turn with Skill tool call", () => {
    const turn = makeTurn({ toolCalls: [{ name: "Skill", arguments: {} }] });
    expect(classifyTurn(turn)).toBe("Delegation");
  });

  it("Planning: user message with no tools", () => {
    const turn = makeTurn({ userMessageText: "let's plan the architecture" });
    expect(classifyTurn(turn)).toBe("Planning");
  });

  it("Planning: does NOT match when tools are present", () => {
    const turn = makeTurn({
      userMessageText: "plan the deployment strategy",
      toolCalls: [{ name: "Read", arguments: { file_path: "README.md" } }],
    });
    // Has tools, so should not be Planning — falls through to Exploration (all read-only)
    expect(classifyTurn(turn)).toBe("Exploration");
  });

  it("Brainstorming: user message with no tools", () => {
    const turn = makeTurn({ userMessageText: "brainstorm ideas for the UI" });
    expect(classifyTurn(turn)).toBe("Brainstorming");
  });

  it("Brainstorming: does NOT match when tools are present", () => {
    const turn = makeTurn({
      userMessageText: "brainstorm some ideas",
      toolCalls: [bashTool("echo hello")],
    });
    // Has Bash but no git/build/test match, no debugging/refactoring/delegation → Coding
    expect(classifyTurn(turn)).toBe("Coding");
  });

  it("Exploration: only Read and Grep tool calls", () => {
    const turn = makeTurn({
      toolCalls: [
        { name: "Read", arguments: { file_path: "src/foo.ts" } },
        { name: "Grep", arguments: { pattern: "foo" } },
      ],
    });
    expect(classifyTurn(turn)).toBe("Exploration");
  });

  it("Exploration: Glob and WebSearch are read-only", () => {
    const turn = makeTurn({
      toolCalls: [
        { name: "Glob", arguments: { pattern: "**/*.ts" } },
        { name: "WebSearch", arguments: { query: "vitest docs" } },
      ],
    });
    expect(classifyTurn(turn)).toBe("Exploration");
  });

  it("Exploration: NOT matched when mix includes write tools", () => {
    const turn = makeTurn({
      toolCalls: [
        { name: "Read", arguments: { file_path: "src/foo.ts" } },
        { name: "Edit", arguments: { file_path: "src/foo.ts", old_string: "a", new_string: "b" } },
      ],
    });
    // Edit is a write tool so not Exploration; no git/build/test/debug/refactor → Coding
    expect(classifyTurn(turn)).toBe("Coding");
  });

  it("Feature Dev: turn with Write tool call (non-test path)", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "Write", arguments: { file_path: "src/components/NewWidget.tsx", content: "" } }],
    });
    expect(classifyTurn(turn)).toBe("Feature Dev");
  });

  it("Coding: turn with Edit tool (non-test, no earlier match)", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "Edit", arguments: { file_path: "src/lib/foo.ts", old_string: "a", new_string: "b" } }],
    });
    expect(classifyTurn(turn)).toBe("Coding");
  });

  it("Coding: turn with Bash (no git/build/test match)", () => {
    const turn = makeTurn({ toolCalls: [bashTool("ls -la")] });
    expect(classifyTurn(turn)).toBe("Coding");
  });

  it("Conversation: assistant turn with no tool calls", () => {
    const turn = makeTurn({ role: "assistant", toolCalls: [] });
    expect(classifyTurn(turn)).toBe("Conversation");
  });

  it("General: user turn with no tools and no keyword matches", () => {
    const turn = makeTurn({ userMessageText: "looks good to me" });
    expect(classifyTurn(turn)).toBe("General");
  });

  it("General: empty user turn with no tools", () => {
    const turn = makeTurn();
    expect(classifyTurn(turn)).toBe("General");
  });

  it("Priority: Git Ops wins over Coding (Bash with git + Edit)", () => {
    const turn = makeTurn({
      toolCalls: [
        bashTool("git commit -m 'wip'"),
        { name: "Edit", arguments: { file_path: "src/foo.ts", old_string: "a", new_string: "b" } },
      ],
    });
    expect(classifyTurn(turn)).toBe("Git Ops");
  });

  it("Priority: Build/Deploy wins over Coding (npm run build + Edit)", () => {
    const turn = makeTurn({
      toolCalls: [
        { name: "Edit", arguments: { file_path: "src/foo.ts", old_string: "a", new_string: "b" } },
        bashTool("npm run build"),
      ],
    });
    expect(classifyTurn(turn)).toBe("Build/Deploy");
  });

  it("Priority: Debugging (isError) wins over Refactoring keyword", () => {
    const turn = makeTurn({
      userMessageText: "refactor and fix this broken module",
      isError: true,
    });
    expect(classifyTurn(turn)).toBe("Debugging");
  });
});
