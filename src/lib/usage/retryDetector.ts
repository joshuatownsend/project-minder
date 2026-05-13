import type { TimelineEvent } from "@/lib/types";
import { EDIT_WRITE_TOOLS, VERIFICATION_PATTERN } from "./oneShotDetector";

export interface RetrySpan {
  /** Index into the TimelineEvent array where the first edit in the cycle starts. */
  startIdx: number;
  /** Index into the TimelineEvent array where the re-edit (cycle close) sits. */
  endIdx: number;
}

export function detectRetrySpans(events: TimelineEvent[]): RetrySpan[] {
  const spans: RetrySpan[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== "tool_use" || !EDIT_WRITE_TOOLS.has(ev.toolName ?? "")) continue;

    // Look ahead for a Bash/test event — stop if a new edit appears first.
    let bashIdx = -1;
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.type !== "tool_use") continue;
      if (EDIT_WRITE_TOOLS.has(next.toolName ?? "")) break;
      if (next.toolName === "Bash" || next.toolName === "PowerShell") {
        const cmd =
          typeof next.toolInput?.command === "string"
            ? next.toolInput.command
            : next.content;
        if (VERIFICATION_PATTERN.test(cmd)) {
          bashIdx = j;
          break;
        }
      }
    }

    if (bashIdx === -1) continue;

    // Scan from the bash event for the next edit — that's the re-edit.
    for (let j = bashIdx + 1; j < events.length; j++) {
      const next = events[j];
      if (next.type === "tool_use" && EDIT_WRITE_TOOLS.has(next.toolName ?? "")) {
        spans.push({ startIdx: i, endIdx: j });
        break;
      }
    }
  }

  return spans;
}
