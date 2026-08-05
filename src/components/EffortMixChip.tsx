"use client";

import { compareEffort } from "@/lib/usage/effort";

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

  return (
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
      }}
      title={`Reasoning effort across ${counted} turn${counted === 1 ? "" : "s"} that recorded it. Turns written before Claude Code ~2.1.212 have no effort and are not counted here, so this can be fewer than the session's total turns.`}
    >
      {entries.map(([level, n]) => `${level}×${n}`).join(" · ")}
    </span>
  );
}
