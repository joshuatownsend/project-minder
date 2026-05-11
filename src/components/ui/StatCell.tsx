"use client";

import type { ReactNode } from "react";

export type StatCellSize = "compact" | "feature";
export type StatCellAccent = "error" | "warn" | "good";

interface StatCellProps {
  label: string;
  value: ReactNode;
  /** Optional sub-line under the value (e.g. units, percentages, qualifier). */
  detail?: string;
  /** Optional right-aligned glyph in the header row (StatsDashboard uses
   *  this for its small Lucide icons; the compact variant ignores `icon`
   *  layout-wise but still renders it inline if passed). */
  icon?: ReactNode;
  /** Tone override for the value text. Default is `var(--text-primary)`.
   *  Stat strips on session / usage pages use this to flag a degraded or
   *  positive metric without changing the surrounding scaffolding. */
  accent?: StatCellAccent;
  /** When true, suppresses the right-side divider — pass on the last
   *  cell of a horizontal strip. */
  last?: boolean;
  /** Visual size variant.
   *
   *   - `compact` (default): 14px×20px padding, 1.25rem mono value,
   *     0.6rem `font-body` uppercase label. Used by in-flow stat strips
   *     where the cell sits inside a larger panel
   *     (SessionDetailView, UsageDashboard).
   *
   *   - `feature`: 12px×16px padding, 1.35rem mono value with heavier
   *     weight, 0.62rem `font-mono` label with wider tracking. Used by
   *     landing-page stat strips that are the marquee content of the
   *     page (StatsDashboard). */
  size?: StatCellSize;
}

const ACCENT_COLOR: Record<StatCellAccent, string> = {
  error: "var(--status-error-text)",
  warn: "var(--accent)",
  good: "var(--status-active-text)",
};

/** Vertical stat tile, shared by the page-prominent stat strips. */
export function StatCell({
  label,
  value,
  detail,
  icon,
  accent,
  last,
  size = "compact",
}: StatCellProps) {
  const valueColor = accent ? ACCENT_COLOR[accent] : "var(--text-primary)";
  const tokens = SIZE_TOKENS[size];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        padding: tokens.padding,
        borderRight: last ? "none" : "1px solid var(--border-subtle)",
        minWidth: tokens.minWidth,
        flex: tokens.flex,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: tokens.labelFontSize,
            fontFamily: tokens.labelFontFamily,
            fontWeight: 600,
            letterSpacing: tokens.labelLetterSpacing,
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          {label}
        </span>
        {icon && (
          <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>{icon}</span>
        )}
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: tokens.valueFontSize,
          fontWeight: tokens.valueFontWeight,
          color: valueColor,
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      {detail && (
        <span
          style={{
            fontSize: tokens.detailFontSize,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.4,
          }}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

const SIZE_TOKENS: Record<
  StatCellSize,
  {
    padding: string;
    minWidth: string | undefined;
    flex: string;
    labelFontSize: string;
    labelFontFamily: string;
    labelLetterSpacing: string;
    valueFontSize: string;
    valueFontWeight: number;
    detailFontSize: string;
  }
> = {
  compact: {
    padding: "14px 20px",
    minWidth: "90px",
    flex: "1 1 90px",
    labelFontSize: "0.6rem",
    labelFontFamily: "var(--font-body)",
    labelLetterSpacing: "0.08em",
    valueFontSize: "1.25rem",
    valueFontWeight: 600,
    detailFontSize: "0.62rem",
  },
  feature: {
    padding: "12px 16px",
    minWidth: undefined,
    flex: "1",
    labelFontSize: "0.62rem",
    labelFontFamily: "var(--font-mono)",
    labelLetterSpacing: "0.1em",
    valueFontSize: "1.35rem",
    valueFontWeight: 700,
    detailFontSize: "0.68rem",
  },
};
