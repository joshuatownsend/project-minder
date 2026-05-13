import { describe, it, expect } from "vitest";
import { detectRetrySpans } from "@/lib/usage/retryDetector";
import type { TimelineEvent } from "@/lib/types";

function toolUse(toolName: string, command?: string): TimelineEvent {
  return {
    type: "tool_use",
    content: command ? `${toolName}: ${command}` : toolName,
    toolName,
    toolInput: command ? { command } : undefined,
  };
}

function assistant(text: string): TimelineEvent {
  return { type: "assistant", content: text };
}

describe("detectRetrySpans", () => {
  it("returns empty array when no retry cycles exist", () => {
    const events: TimelineEvent[] = [
      assistant("I will edit the file"),
      toolUse("Edit", "src/foo.ts"),
      toolUse("Bash", "git status"),
    ];
    expect(detectRetrySpans(events)).toEqual([]);
  });

  it("detects a simple Edit → Bash(test) → Edit cycle", () => {
    const events: TimelineEvent[] = [
      toolUse("Edit", "src/foo.ts"),
      toolUse("Bash", "npm test"),
      toolUse("Edit", "src/foo.ts"),
    ];
    const spans = detectRetrySpans(events);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ startIdx: 0, endIdx: 2 });
  });

  it("detects a Write → Bash(vitest) → Edit cycle", () => {
    const events: TimelineEvent[] = [
      assistant("writing"),
      toolUse("Write", "src/bar.ts"),
      toolUse("Bash", "npm run test:watch"),
      assistant("test output"),
      toolUse("Edit", "src/bar.ts"),
    ];
    const spans = detectRetrySpans(events);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ startIdx: 1, endIdx: 4 });
  });

  it("does NOT flag Edit → non-test Bash → Edit as a retry", () => {
    const events: TimelineEvent[] = [
      toolUse("Edit", "src/foo.ts"),
      toolUse("Bash", "git add ."),
      toolUse("Edit", "src/bar.ts"),
    ];
    expect(detectRetrySpans(events)).toEqual([]);
  });

  it("stops the test-search at the next Edit (no test between edits)", () => {
    const events: TimelineEvent[] = [
      toolUse("Edit", "src/a.ts"),
      toolUse("Edit", "src/b.ts"),
      toolUse("Bash", "npm test"),
      toolUse("Edit", "src/c.ts"),
    ];
    const spans = detectRetrySpans(events);
    // Second edit starts a new potential cycle (it has Bash(test) before the third edit)
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ startIdx: 1, endIdx: 3 });
  });

  it("detects multiple independent retry cycles", () => {
    const events: TimelineEvent[] = [
      toolUse("Edit", "src/a.ts"),
      toolUse("Bash", "npm test"),
      toolUse("Edit", "src/a.ts"),
      assistant("now working on b"),
      toolUse("Write", "src/b.ts"),
      toolUse("Bash", "npm run build"),
      toolUse("Edit", "src/b.ts"),
    ];
    const spans = detectRetrySpans(events);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ startIdx: 0, endIdx: 2 });
    expect(spans[1]).toEqual({ startIdx: 4, endIdx: 6 });
  });

  it("detects MultiEdit as the start of a cycle", () => {
    const events: TimelineEvent[] = [
      toolUse("MultiEdit"),
      toolUse("Bash", "npm test"),
      toolUse("Edit", "src/foo.ts"),
    ];
    const spans = detectRetrySpans(events);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ startIdx: 0, endIdx: 2 });
  });

  it("uses toolInput.command over content for the test pattern", () => {
    const event: TimelineEvent = {
      type: "tool_use",
      toolName: "Bash",
      content: "Bash: some-custom-test-runner",
      toolInput: { command: "npm test" },
    };
    const events: TimelineEvent[] = [
      toolUse("Edit", "src/foo.ts"),
      event,
      toolUse("Edit", "src/foo.ts"),
    ];
    const spans = detectRetrySpans(events);
    expect(spans).toHaveLength(1);
  });

  it("returns empty array for an empty event list", () => {
    expect(detectRetrySpans([])).toEqual([]);
  });
});
