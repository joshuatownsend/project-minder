/**
 * What a subagent card can honestly say about where its turn count came from.
 *
 * Pure and separate from the component because the rule is subtle and was got
 * wrong on the first attempt: it compared Claude Code's `metaTurnCount` against
 * a `messageCount` that the default SQLite backend hard-codes because it cannot
 * index sidechain entries. Every meta-sourced subagent therefore rendered as an
 * amber "14 turns recorded · 0 counted" disagreement — a documented backend
 * limitation presented as a data conflict (Codex review of #403).
 *
 * The rule: a disagreement requires two real counts. One count is worth showing
 * on its own. Neither is worth a badge beyond the provenance note.
 */

export interface SubagentProvenance {
  /** Chip text. */
  label: string;
  /** Full sentence for the tooltip and the screen-reader twin. */
  explanation: string;
  /** True only when two counts exist and differ — drives the amber styling. */
  disagrees: boolean;
}

export function describeSubagentProvenance(opts: {
  metaSourced?: boolean;
  metaTurnCount?: number;
  messageCount?: number;
}): SubagentProvenance | null {
  const { metaSourced, metaTurnCount, messageCount } = opts;

  // An inferred card is the norm, not an anomaly worth a badge on every row.
  if (!metaSourced) return null;

  const hasBoth = typeof metaTurnCount === "number" && typeof messageCount === "number";
  const disagrees = hasBoth && metaTurnCount !== messageCount;
  const soleCount = !hasBoth && typeof metaTurnCount === "number";

  if (disagrees) {
    return {
      disagrees: true,
      label: `${metaTurnCount} turns recorded · ${messageCount} counted`,
      explanation:
        `Claude Code's own record reports ${metaTurnCount} turns for this subagent; ` +
        `${messageCount} were counted from the transcript.`,
    };
  }

  if (soleCount) {
    // Worth showing rather than suppressing: on the default backend this is the
    // only turn count that exists for the subagent.
    return {
      disagrees: false,
      label: `${metaTurnCount} turns recorded`,
      explanation:
        `${metaTurnCount} turns, from Claude Code's own record. This view does not index ` +
        `subagent transcripts, so there is no independent count to compare against.`,
    };
  }

  return {
    disagrees: false,
    label: "from Claude Code's record",
    explanation:
      "Details for this subagent come from Claude Code's own record, not inferred from the parent transcript.",
  };
}
