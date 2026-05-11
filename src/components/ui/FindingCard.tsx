"use client";

import type { ReactNode } from "react";
import { severityTokens, type SeverityTone } from "./design";

interface FindingCardProps {
  /** Canonical tone — controls bg / border / text / icon. Consumers map
   *  their own taxonomy (DiagnosisPanel's `P0/P1/P2`, EfficiencyTab's
   *  `high/medium/low`) onto `crit/high/med` at the call site so the
   *  shared card doesn't carry a translation table. */
  tone: SeverityTone;
  /** Tone label shown next to the icon. Defaults to `tone.toUpperCase()`,
   *  but consumers pass an explicit string when their taxonomy already
   *  has its own labels (e.g. DiagnosisPanel keeps `P0/P1/P2`,
   *  EfficiencyTab keeps `HIGH/MEDIUM/LOW`). */
  toneLabel?: string;
  /** Category / code shown in the header row, mono small-caps. */
  tag?: string;
  /** Optional right-aligned slot in the header — used by both consumers
   *  for different meta values: DiagnosisPanel passes `~$0.05` impact
   *  text, EfficiencyTab passes `~1.2K tokens` saveable. Accepting a
   *  `ReactNode` instead of a typed shape lets each consumer keep its
   *  exact rendering. */
  rightSlot?: ReactNode;
  /** Body content rendered below the header. Consumers pass their own
   *  inner structure (e.g. DiagnosisPanel has `finding` + `advice` as
   *  two paragraphs; EfficiencyTab has `title` + `explanation` + `fix`
   *  as three). This preserves per-consumer typography without
   *  expanding the props surface to cover every variant. */
  children: ReactNode;
  /** Horizontal gap between header items (tone label, tag, right slot).
   *  Defaults to 8px — DiagnosisPanel's original treatment. EfficiencyTab
   *  passes 10 to preserve its prior `FindingRow` spacing. */
  headerGap?: number;
}

/** Outer shell + header row for a severity-tinted finding card.
 *
 *  Shared by `DiagnosisPanel`'s `DiagnosisFindingCard` wrapper and
 *  `EfficiencyTab`'s `FindingRow`. The card itself is the same shape in
 *  both — tone-tinted background, header row with icon + tone label +
 *  category tag + optional right-aligned meta, then a body block — only
 *  the body's typography differs, which is why `children` is the right
 *  abstraction (not a larger prop union).
 *
 *  `ClaudeMdAuditPanel` does NOT use this component: its cards are
 *  uniform-neutral, with severity expressed by the group header instead
 *  of per-card color. See `severityTokens` documentation for the tone
 *  mapping table. */
export function FindingCard({
  tone,
  toneLabel,
  tag,
  rightSlot,
  children,
  headerGap = 8,
}: FindingCardProps) {
  const t = severityTokens[tone];
  const label = toneLabel ?? tone.toUpperCase();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "11px 14px",
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: `${headerGap}px` }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: t.text,
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {t.icon}
          {label}
        </span>
        {tag && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {tag}
          </span>
        )}
        {rightSlot && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-secondary)",
            }}
          >
            {rightSlot}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
