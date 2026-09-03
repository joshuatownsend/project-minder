"use client";

import { presenceFlags, type Labels, type PresenceInput } from "@/lib/groups/presence";

/**
 * Divergence flags for the group page. Which chips an item earns is decided
 * by the pure `presenceFlags()` (`src/lib/groups/presence.ts`, tested); this
 * file only styles them. Chips use the dashboard's amber attention tokens —
 * a divergence is something the user may need to act on — and render
 * nothing when every location agrees, so a group whose copies match reads
 * exactly like a single project.
 */

export type { Labels };

const CHIP: React.CSSProperties = {
  fontSize: "0.6rem",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  letterSpacing: "0.04em",
  padding: "1px 5px",
  borderRadius: "3px",
  whiteSpace: "nowrap",
  display: "inline-block",
  // Chips sit inside uppercase section headings on the Board and Ops tabs;
  // a location label must keep its case (`C:\dev`, `WSL Ubuntu`).
  textTransform: "none",
};

export function DivergenceChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        ...CHIP,
        color: "var(--accent)",
        background: "var(--accent-bg)",
        border: "1px solid var(--accent-border)",
      }}
    >
      {children}
    </span>
  );
}

export function LocationChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} style={{ ...CHIP, color: "var(--info)", background: "var(--info-bg)" }}>
      {children}
    </span>
  );
}

export function PresenceChips(input: PresenceInput) {
  const flags = presenceFlags(input);
  if (flags.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
      {flags.map((f) => (
        <DivergenceChip key={f.key} title={f.title}>
          {f.text}
        </DivergenceChip>
      ))}
    </span>
  );
}
