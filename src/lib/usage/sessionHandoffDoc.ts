import type { UsageTurn } from "./types";
import type { HandoffFacts, CompactionFidelity } from "./sessionHandoff";

export type HandoffVerbosity = "minimal" | "standard" | "verbose" | "full";

export interface HandoffDocInput {
  sessionId: string;
  projectName?: string;
  facts: HandoffFacts;
  fidelity?: CompactionFidelity;
  turns: UsageTurn[];
  verbosity: HandoffVerbosity;
}

const VERBOSITY_TAIL: Record<HandoffVerbosity, number | null> = {
  minimal: 0,
  standard: 10,
  verbose: 20,
  full: null, // all turns
};

const FACTS_CAP: Record<HandoffVerbosity, number | null> = {
  minimal: null, // counts only
  standard: 25,
  verbose: null,
  full: null,
};

export function generateHandoffDoc(input: HandoffDocInput): string {
  const { sessionId, projectName, facts, fidelity, turns, verbosity } = input;
  const lines: string[] = [];

  // ─── Header ──────────────────────────────────────────────────────────────
  lines.push(`# Handoff — ${projectName ?? "Unknown Project"}`);
  lines.push(`**Session:** \`${sessionId}\``);

  const firstTs = turns[0]?.timestamp;
  const lastTs = turns[turns.length - 1]?.timestamp;
  if (firstTs && lastTs) {
    const durationMs =
      new Date(lastTs).getTime() - new Date(firstTs).getTime();
    const minutes = Math.round(durationMs / 60_000);
    lines.push(`**Duration:** ~${minutes} min`);
  }

  lines.push("");

  // ─── Original task ───────────────────────────────────────────────────────
  lines.push("## Original Task");
  let taskText = "_No user prompt found_";
  if (facts.firstUserPrompt) {
    taskText = verbosity === "minimal"
      ? facts.firstUserPrompt.split(/\r?\n/)[0].slice(0, 300)
      : facts.firstUserPrompt;
  }
  lines.push(taskText);
  lines.push("");

  // ─── Current state ───────────────────────────────────────────────────────
  lines.push("## Current State");
  if (facts.lastAssistantText) {
    const text =
      verbosity === "minimal"
        ? facts.lastAssistantText.slice(0, 500)
        : facts.lastAssistantText;
    lines.push(text);
  } else {
    lines.push("_No assistant response found_");
  }
  lines.push("");

  // ─── Facts ───────────────────────────────────────────────────────────────
  const cap = FACTS_CAP[verbosity];
  lines.push("## Facts");

  if (verbosity === "minimal") {
    // Counts only
    lines.push(
      `- **Files modified:** ${facts.filesModified.length}`,
      `- **Files read:** ${facts.filesRead.length}`,
      `- **Git commits:** ${facts.gitCommits.length}`,
      `- **Key commands:** ${facts.keyCommands.length}`
    );
  } else {
    // Full lists
    if (facts.filesModified.length > 0) {
      lines.push("### Files Modified");
      const files = cap ? facts.filesModified.slice(0, cap) : facts.filesModified;
      for (const f of files) lines.push(`- \`${f}\``);
      if (cap && facts.filesModified.length > cap) {
        lines.push(`  _…and ${facts.filesModified.length - cap} more_`);
      }
      lines.push("");
    }

    if (facts.filesRead.length > 0) {
      lines.push("### Files Read");
      const files = cap ? facts.filesRead.slice(0, cap) : facts.filesRead;
      for (const f of files) lines.push(`- \`${f}\``);
      if (cap && facts.filesRead.length > cap) {
        lines.push(`  _…and ${facts.filesRead.length - cap} more_`);
      }
      lines.push("");
    }

    if (facts.gitCommits.length > 0) {
      lines.push("### Git Commits");
      for (const commit of facts.gitCommits) {
        lines.push(`- ${commit.message}`);
        if (verbosity !== "standard" && commit.bodyLines?.length) {
          for (const body of commit.bodyLines) {
            lines.push(`  ${body}`);
          }
        }
      }
      lines.push("");
    }

    if (facts.keyCommands.length > 0) {
      lines.push("### Key Commands");
      const cmds = cap ? facts.keyCommands.slice(0, cap) : facts.keyCommands;
      for (const cmd of cmds) lines.push(`- \`${cmd}\``);
      lines.push("");
    }
  }

  // ─── Fidelity callout (verbose/full only) ────────────────────────────────
  if (fidelity && (verbosity === "verbose" || verbosity === "full")) {
    lines.push("## Compaction Fidelity");
    const pct = Math.round(fidelity.score * 100);
    lines.push(
      `**Score:** ${pct}% (${fidelity.factsMentioned}/${fidelity.factsTotal} facts mentioned)`
    );
    if (fidelity.isLowFidelity) {
      lines.push(
        `> ⚠️ **Low fidelity** — the LLM summary may have omitted important context.`
      );
      if (fidelity.missingFacts.length > 0) {
        lines.push("**Omitted facts:**");
        for (const f of fidelity.missingFacts) lines.push(`- ${f}`);
      }
    }
    lines.push("");
  }

  // ─── Conversation tail ───────────────────────────────────────────────────
  const tailCount = VERBOSITY_TAIL[verbosity];
  const tailTurns =
    tailCount === null
      ? turns
      : tailCount === 0
        ? []
        : turns.slice(-tailCount);

  if (tailTurns.length > 0) {
    lines.push("## Recent Conversation");
    for (const t of tailTurns) {
      const role = t.role === "user" ? "**User**" : "**Assistant**";
      const text =
        t.role === "user"
          ? (t.userMessageText ?? "")
          : (t.assistantText ?? "");
      if (!text) continue;
      lines.push(`${role}: ${text}`);
      lines.push("");
    }
  }

  // ─── Full tool breakdown (full verbosity) ────────────────────────────────
  if (verbosity === "full") {
    const toolCounts = new Map<string, number>();
    for (const t of turns) {
      for (const tc of t.toolCalls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
      }
    }
    if (toolCounts.size > 0) {
      lines.push("## Tool Call Breakdown");
      const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name, count] of sorted) {
        lines.push(`- **${name}:** ${count}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
