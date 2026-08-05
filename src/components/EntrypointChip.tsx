"use client";

import { entrypointLabel, isAutomatedEntrypoint, isBackgroundSession } from "@/lib/usage/entrypoint";

/**
 * Marks a session that nobody was watching (A3).
 *
 * **Renders nothing for an ordinary interactive session, by design.** By
 * session count 95.5% of this corpus is SDK-driven, so a chip on every row
 * would be a chip on almost every row — which marks nothing and costs a column
 * of noise. The session list is a work log a person reads to find their *own*
 * work, and what makes that possible is flagging the runs that aren't theirs.
 *
 * Also renders nothing when the entrypoint is absent: a session indexed before
 * Minder read the field is not evidence of an automated run, and guessing
 * would mislabel real interactive work.
 */
export function EntrypointChip({
  entrypoint,
  sessionKind,
}: {
  entrypoint?: string;
  sessionKind?: string;
}) {
  const background = isBackgroundSession(sessionKind);
  const automated = !!entrypoint && isAutomatedEntrypoint(entrypoint);
  if (!automated && !background) return null;

  // A backgrounded interactive session is still interactive — say "background"
  // rather than relabelling it as an SDK run.
  const label = automated ? entrypointLabel(entrypoint!) : "background";
  const title = automated
    ? `Started by a program (${entrypoint}), not from a terminal${background ? ", and backgrounded" : ""}.`
    : "Ran in the background — started from a terminal, but unattended.";

  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--text-muted)",
        border: "1px solid var(--border)",
        borderRadius: "3px",
        padding: "1px 4px",
        whiteSpace: "nowrap",
      }}
    >
      {/* The visible label is an abbreviation; the sentence carries the meaning. */}
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
