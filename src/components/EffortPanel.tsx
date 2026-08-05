"use client";

import { formatCost, formatTokens } from "@/lib/format";
import { UNKNOWN_EFFORT } from "@/lib/usage/effort";
import type { EffortBreakdown } from "@/lib/usage/types";

/**
 * Spend and first-pass success by reasoning effort (A2).
 *
 * Cost and one-shot rate share a row on purpose. Read apart they each mislead:
 * cost alone makes `xhigh` look like waste, and success rate alone ignores what
 * the success cost. The question the panel exists to answer — does raising
 * effort buy a better outcome or just a larger bill — is only visible when the
 * two sit side by side.
 *
 * Presentational and props-driven, so `/usage` and the per-project Costs tab
 * render the identical thing from their own already-fetched report.
 */
export function EffortPanel({ rows, currency, fxRate }: {
  rows: EffortBreakdown[];
  currency: string;
  fxRate: number;
}) {
  const withCost = rows.filter((r) => r.turns > 0);
  if (withCost.length === 0) return <EmptyNote>No turns in this period.</EmptyNote>;

  // Every turn in an unknown bucket means the field genuinely isn't available
  // for this data — either the transcripts predate it, or the index hasn't
  // been rebuilt since Minder learned to read it. A lone grey bar labelled
  // "unknown" reads as a broken chart, so say what it means instead.
  if (withCost.length === 1 && withCost[0].effort === UNKNOWN_EFFORT) {
    return (
      <EmptyNote>
        No reasoning-effort data in this period. Claude Code began recording it
        in ~2.1.212; older transcripts have none, and sessions indexed before
        Minder learned to read the field are refreshed on the next re-index.
      </EmptyNote>
    );
  }

  const maxCost = withCost.reduce((m, r) => Math.max(m, r.cost), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {withCost.map((r) => {
        const unknown = r.effort === UNKNOWN_EFFORT;
        return (
          <div key={r.effort} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.72rem",
                color: unknown ? "var(--text-muted)" : "var(--text-secondary)",
                width: "72px", flexShrink: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              title={
                unknown
                  ? "Turns with no recorded effort — pre-2.1.212 transcripts, or turns Claude Code omitted it on. Not a reasoning level."
                  : undefined
              }
            >
              {r.effort}
            </span>

            <div style={{
              flex: 1, background: "var(--bg-elevated)",
              borderRadius: "2px", height: "10px", overflow: "hidden",
            }}>
              <div style={{
                width: "100%",
                transform: `scaleX(${maxCost > 0 ? r.cost / maxCost : 0})`,
                transformOrigin: "left",
                height: "100%",
                background: unknown ? "var(--text-muted)" : "var(--accent)",
                borderRadius: "2px",
                transition: "transform 0.3s ease",
              }} />
            </div>

            <span style={{
              fontFamily: "var(--font-mono)", fontSize: "0.7rem",
              color: "var(--text-primary)", width: "64px", textAlign: "right", flexShrink: 0,
            }}>
              {formatCost(r.cost, currency, fxRate)}
            </span>

            <span style={{
              fontFamily: "var(--font-mono)", fontSize: "0.62rem",
              color: "var(--text-muted)", width: "62px", textAlign: "right", flexShrink: 0,
            }}>
              {formatTokens(r.tokens)}
            </span>

            <OneShotCell row={r} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * First-pass success for one effort level.
 *
 * Renders an em-dash, not `0%`, when the level anchored no verified task. The
 * two are opposite readings of the same cell: 0% says "everything this level
 * touched needed a retry", absence says "nothing measurable happened here".
 * Showing 0% would also sort this level below one that genuinely failed
 * everything in any rate-ordered view.
 */
function OneShotCell({ row }: { row: EffortBreakdown }) {
  if (row.oneShotRate === undefined) {
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)", fontSize: "0.66rem",
          color: "var(--text-muted)", width: "112px", textAlign: "right", flexShrink: 0,
        }}
        title="No verified tasks at this effort — nothing to measure, not a 0% success rate."
      >
        —
      </span>
    );
  }
  const pct = Math.round(row.oneShotRate * 100);
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)", fontSize: "0.66rem",
        color: "var(--text-secondary)", width: "112px", textAlign: "right", flexShrink: 0,
      }}
      title={`${row.oneShotTasks} of ${row.verifiedTasks} tasks started at this effort passed verification without a follow-up edit.`}
    >
      {pct}% 1-shot
      <span style={{ color: "var(--text-muted)" }}> ({row.verifiedTasks})</span>
    </span>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "0.7rem", color: "var(--text-muted)",
      fontFamily: "var(--font-body)", lineHeight: 1.5, maxWidth: "62ch",
    }}>
      {children}
    </div>
  );
}
