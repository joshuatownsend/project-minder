"use client";

import { formatCost } from "@/lib/format";
import {
  UNKNOWN_ENTRYPOINT,
  entrypointLabel,
  isAutomatedEntrypoint,
} from "@/lib/usage/entrypoint";
import type { EntrypointBreakdown } from "@/lib/usage/types";

/**
 * Spend and volume by session entrypoint (A3) — interactive versus SDK-driven.
 *
 * Share of **sessions** and share of **spend** sit on the same row on purpose.
 * On the author's corpus 95.5% of sessions are SDK-driven, which read alone
 * says "almost everything I run is automated" — a conclusion that is true
 * about counts and usually false about money, because an automated run is a
 * few dozen lines while an interactive one runs for hours. Showing one share
 * without the other invites exactly the wrong inference about where the cost
 * actually goes, so the panel refuses to show either alone.
 *
 * Presentational and props-driven, so `/usage` and the per-project Costs tab
 * render the identical thing from their own already-fetched report.
 */
export function EntrypointPanel({ rows, currency, fxRate }: {
  rows: EntrypointBreakdown[];
  currency: string;
  fxRate: number;
}) {
  const withData = rows.filter((r) => r.sessions > 0);
  if (withData.length === 0) return <EmptyNote>No sessions in this period.</EmptyNote>;

  // Every session in the unknown bucket means the field isn't available for
  // this data — in practice, an index not yet rebuilt since Minder learned to
  // read it. A lone grey "unknown" row reads as a broken chart, so say why.
  if (withData.length === 1 && withData[0].entrypoint === UNKNOWN_ENTRYPOINT) {
    return (
      <EmptyNote>
        No entrypoint data in this period. Sessions indexed before Minder
        learned to read the field are refreshed on the next re-index.
      </EmptyNote>
    );
  }

  const totalSessions = withData.reduce((s, r) => s + r.sessions, 0);
  const totalCost = withData.reduce((s, r) => s + r.cost, 0);
  const maxCost = withData.reduce((m, r) => Math.max(m, r.cost), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {withData.map((r) => {
        const unknown = r.entrypoint === UNKNOWN_ENTRYPOINT;
        const sessionShare = totalSessions > 0 ? r.sessions / totalSessions : 0;
        const costShare = totalCost > 0 ? r.cost / totalCost : 0;
        const automated = isAutomatedEntrypoint(r.entrypoint);

        const title =
          `${r.sessions.toLocaleString()} session${r.sessions === 1 ? "" : "s"} ` +
          `(${pct(sessionShare)} of sessions, ${pct(costShare)} of spend), ` +
          `averaging ${formatCost(r.avgCostPerSession, currency, fxRate)} each` +
          (r.backgroundSessions > 0
            ? `. ${r.backgroundSessions} ran in the background.`
            : ".") +
          (unknown
            ? " No entrypoint recorded — not a kind of session."
            : automated
              ? " Program-driven, with no one watching."
              : " Started from a terminal.");

        return (
          <div
            key={r.entrypoint}
            title={title}
            style={{ display: "flex", alignItems: "center", gap: "10px" }}
          >
            {/*
              `title` is a mouse-only affordance — not exposed on keyboard
              focus, absent entirely on touch. The row's numbers are all
              visible, but the share-of-sessions-versus-share-of-spend
              relationship is the point of the panel and only the tooltip
              states it in words, so it goes in the accessibility tree as real
              text via `.sr-only` (preferred over `aria-label`, which ARIA does
              not reliably apply to a generic element).
            */}
            <span className="sr-only">{`${entrypointLabel(r.entrypoint)}: ${title}`}</span>

            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.72rem",
                color: unknown ? "var(--text-muted)" : "var(--text-secondary)",
                width: "96px", flexShrink: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {entrypointLabel(r.entrypoint)}
            </span>

            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                color: "var(--text-muted)", width: "92px", flexShrink: 0, textAlign: "right",
              }}
            >
              {r.sessions.toLocaleString()} · {pct(sessionShare)}
            </span>

            <div
              aria-hidden="true"
              style={{
                flex: 1, background: "var(--bg-elevated)",
                borderRadius: "2px", height: "10px", overflow: "hidden",
              }}
            >
              <div style={{
                width: "100%",
                transform: `scaleX(${maxCost > 0 ? r.cost / maxCost : 0})`,
                transformOrigin: "left",
                height: "100%",
                // Automated runs are muted so the eye lands on supervised
                // spend first — the row a person can actually act on.
                background: unknown
                  ? "var(--text-muted)"
                  : automated
                    ? "var(--text-secondary)"
                    : "var(--accent)",
                borderRadius: "2px",
                transition: "transform 0.3s ease",
              }} />
            </div>

            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.7rem",
                color: "var(--text-primary)", width: "64px", textAlign: "right", flexShrink: 0,
              }}
            >
              {formatCost(r.cost, currency, fxRate)}
            </span>

            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                color: "var(--text-muted)", width: "48px", textAlign: "right", flexShrink: 0,
              }}
            >
              {pct(costShare)}
            </span>

            <span
              aria-hidden="true"
              title="Average cost per session"
              style={{
                fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                color: "var(--text-muted)", width: "72px", textAlign: "right", flexShrink: 0,
              }}
            >
              {formatCost(r.avgCostPerSession, currency, fxRate)}/ea
            </span>
          </div>
        );
      })}
      <Legend />
    </div>
  );
}

/**
 * Names the two percentage columns, which are otherwise indistinguishable —
 * both render as "NN%" and they mean opposite things.
 */
function Legend() {
  return (
    <p style={{
      fontSize: "0.62rem", color: "var(--text-muted)",
      fontFamily: "var(--font-body)", lineHeight: 1.5,
      margin: "8px 0 0", maxWidth: "62ch",
    }}>
      Sessions and their share of the total, then spend and its share. The two
      rarely match: automated runs are numerous and short, interactive ones few
      and long, so a large share of sessions can be a small share of cost.
    </p>
  );
}

function pct(v: number): string {
  if (v <= 0) return "0%";
  // Below 0.5% would round to "0%" and read as nothing at all.
  return v < 0.005 ? "<1%" : `${Math.round(v * 100)}%`;
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
