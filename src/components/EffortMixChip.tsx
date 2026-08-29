"use client";

import { compareEffort } from "@/lib/usage/effort";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Per-session reasoning-effort mix (A2) — e.g. `high×12 · xhigh×3`.
 *
 * Renders nothing when the session recorded no effort at all, which is the
 * common case on this corpus: the field only exists from Claude Code ~2.1.212.
 * A chip reading `0 turns` or `unknown` on every older session would be noise
 * on every row of the browser and would say nothing the absence doesn't.
 *
 * The counts deliberately do NOT sum to the session's assistant-turn count —
 * turns written before the field existed are simply absent from the mix. The
 * tooltip says so, because a chip claiming "12 turns" next to a card claiming
 * "40 messages" otherwise looks like a bug.
 */
export function EffortMixChip({ mix }: { mix?: Record<string, number> }) {
  if (!mix) return null;
  const entries = Object.entries(mix)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => compareEffort(a, b));
  if (entries.length === 0) return null;

  const counted = entries.reduce((s, [, n]) => s + n, 0);

  // The mix itself is NOT restated here. It used to be — the trailing
  // `high 12, xhigh 3` existed because #380's fix marked the visible label
  // `aria-hidden`, so the description was the only place a screen reader could
  // hear the counts. #391 stopped hiding the label, and the list became a
  // duplicate: a focused chip announced every level and count twice (Codex P2,
  // PR #519 — the same defect the cache-hit chip had one round earlier).
  //
  // The rule this leaves behind: a `Tooltip` description carries what the
  // visible label CANNOT say. Once the label is reachable, restating it is a
  // stutter, not redundancy for safety.
  const explanation =
    `Reasoning effort across ${counted} turn${counted === 1 ? "" : "s"} that ` +
    `recorded it. Turns written before Claude Code reported effort are not ` +
    `counted, so this need not sum to the session's turn count.`;

  return (
    // #391: through `Tooltip` rather than `title` + `.sr-only`. "Why doesn't
    // the mix add up to the turn count?" is now answerable by hover, keyboard
    // focus AND tap — and the sentence exists once instead of being kept in
    // step across two copies, which is how #380's fix drifted onto the effort
    // PANEL and missed this chip.
    <Tooltip content={explanation}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.62rem",
          color: "var(--text-muted)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "3px",
          padding: "1px 5px",
          flexShrink: 0,
          cursor: "help",
        }}
      >
        {entries.map(([level, n]) => `${level}×${n}`).join(" · ")}
      </span>
    </Tooltip>
  );
}
