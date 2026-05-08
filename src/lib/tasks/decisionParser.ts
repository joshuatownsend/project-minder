import "server-only";

export type DecisionKind = "decision" | "inbox";

export interface DecisionEvent {
  kind: DecisionKind;
  prompt: string;
  /** Choices parsed from `[a, b, c]` notation. Only set for `kind="decision"`. */
  choices: string[] | null;
}

// DECISION: <prompt> optionally followed by [choice1, choice2, ...]
// Group 1: prompt text, Group 2: raw choices string (optional)
const DECISION_RE = /^\s*DECISION:\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/i;
// INBOX: <message> — Group 1: message text
const INBOX_RE = /^\s*INBOX:\s+(.+?)\s*$/i;
// A line whose trimmed form starts with ``` toggles fence state
const FENCE_RE = /^```/;

/**
 * Factory for a stateful, line-buffered, fence-aware DECISION/INBOX parser.
 *
 * Feed lines one at a time. Markers inside triple-backtick fenced blocks are
 * silently ignored (Claude may legitimately print code containing the marker
 * strings). A single `inFence` boolean is toggled on each fence-boundary line.
 *
 * Usage:
 *   const parser = createDecisionParser();
 *   parser.feed("DECISION: Overwrite auth.ts? [yes, no]");
 *   // → [{ kind: "decision", prompt: "Overwrite auth.ts?", choices: ["yes","no"] }]
 *   parser.feed("INBOX: Still working on the build");
 *   // → [{ kind: "inbox", prompt: "Still working on the build", choices: null }]
 */
export function createDecisionParser(): {
  feed(line: string): DecisionEvent[];
  finish(): void;
} {
  let inFence = false;

  function feed(line: string): DecisionEvent[] {
    const trimmed = line.trimEnd();

    // Toggle fence state on any line starting with ```
    if (FENCE_RE.test(trimmed.trimStart())) {
      inFence = !inFence;
      return [];
    }

    if (inFence) return [];

    const decisionMatch = trimmed.match(DECISION_RE);
    if (decisionMatch) {
      const rawPrompt = decisionMatch[1];
      const rawChoices = decisionMatch[2];
      const choices = rawChoices
        ? rawChoices.split(",").map((c) => c.trim()).filter(Boolean)
        : null;
      return [{ kind: "decision", prompt: rawPrompt.trim(), choices }];
    }

    const inboxMatch = trimmed.match(INBOX_RE);
    if (inboxMatch) {
      return [{ kind: "inbox", prompt: inboxMatch[1].trim(), choices: null }];
    }

    return [];
  }

  function finish() {
    inFence = false;
  }

  return { feed, finish };
}
