import type { TimelineEvent } from "@/lib/types";

export interface RetrySpan {
  /** Index into the TimelineEvent array where the first edit in the cycle starts. */
  startIdx: number;
  /** Index into the TimelineEvent array where the re-edit (cycle close) sits. */
  endIdx: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_PATTERN =
  /\b(test|vitest|jest|pytest|npm test|npm run test|build|lint|tsc|eslint|check)\b/i;

/**
 * Detects Edit → Bash(test) → re-Edit retry cycles in a session timeline.
 *
 * A cycle is: an edit tool call, followed (before the next edit) by a
 * Bash/PowerShell call matching a test/build keyword, followed by another
 * edit. Whether the test passed or failed is not inspected — the structural
 * pattern is sufficient to identify "Claude tried, ran a check, then tried
 * again."
 */
export function detectRetrySpans(events: TimelineEvent[]): RetrySpan[] {
  const spans: RetrySpan[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== "tool_use" || !EDIT_TOOLS.has(ev.toolName ?? "")) continue;

    // Look ahead for a Bash/test event — stop if a new edit appears first.
    let bashIdx = -1;
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.type !== "tool_use") continue;
      if (EDIT_TOOLS.has(next.toolName ?? "")) break;
      if (next.toolName === "Bash" || next.toolName === "PowerShell") {
        const cmd =
          typeof next.toolInput?.command === "string"
            ? next.toolInput.command
            : next.content;
        if (TEST_PATTERN.test(cmd)) {
          bashIdx = j;
          break;
        }
      }
    }

    if (bashIdx === -1) continue;

    // Scan from the bash event for the next edit — that's the re-edit.
    for (let j = bashIdx + 1; j < events.length; j++) {
      const next = events[j];
      if (next.type === "tool_use" && EDIT_TOOLS.has(next.toolName ?? "")) {
        spans.push({ startIdx: i, endIdx: j });
        break;
      }
    }
  }

  return spans;
}
