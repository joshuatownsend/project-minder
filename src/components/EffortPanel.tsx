"use client";

import { formatCost, formatTokens } from "@/lib/format";
import { UNKNOWN_EFFORT, MIN_TASKS_FOR_RATE } from "@/lib/usage/effort";
import { SampleBadge } from "@/components/stats/SampleBadge";
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
      <CausalityNote />
    </div>
  );
}

/**
 * The caveat that keeps the panel honest.
 *
 * Read naively the table asserts a causal claim it cannot support: on the
 * author's corpus `xhigh` shows a *lower* first-pass rate than `medium`, which
 * invites the conclusion that raising effort makes things worse. The likelier
 * explanation runs the other way — you reach for higher effort on the problems
 * you already expect to be hard, so difficulty is confounded with the setting
 * being measured.
 *
 * This sits under the table rather than in the docs because that is where the
 * misreading happens. A caveat nobody encounters at the point of reading is
 * not a caveat.
 */
function CausalityNote() {
  return (
    <p style={{
      fontSize: "0.62rem", color: "var(--text-muted)",
      fontFamily: "var(--font-body)", lineHeight: 1.5,
      margin: "8px 0 0", maxWidth: "62ch",
    }}>
      Higher effort is usually chosen for harder work, so these rates describe
      what happened at each setting — not what the setting caused. A lower rate
      at higher effort more likely reflects harder problems than worse output.
    </p>
  );
}

/**
 * First-pass success for one effort level.
 *
 * Renders an em-dash, not `0%`, in two distinct situations:
 *
 *   - the level anchored no verified task at all, and
 *   - it anchored too few for a percentage to mean anything
 *     ({@link MIN_TASKS_FOR_RATE}).
 *
 * The tooltips differ so the two stay distinguishable, and the denominator is
 * shown either way via the shared {@link SampleBadge} — the same `n=…` pill
 * the OTEL stats cards use for exactly this idea, so a thin sample looks the
 * same everywhere in the app rather than inventing a second visual language
 * for it. The badge turns amber below the threshold on its own, which is why
 * a suppressed row reads as "not enough data yet" and not as a missing
 * feature. A bucket with NO tasks gets no badge: `n=0` is absence, not a small
 * sample, and the em-dash already says so.
 *
 * `0%` is never rendered for absence. The two are opposite readings of the
 * same cell: 0% says "everything this level touched needed a retry", absence
 * says "nothing measurable happened here". Showing 0% would also sort this
 * level below one that genuinely failed everything in any rate-ordered view.
 */
function OneShotCell({ row }: { row: EffortBreakdown }) {
  const measured = row.oneShotRate !== undefined;
  const tooThin = measured && row.verifiedTasks < MIN_TASKS_FOR_RATE;
  const showRate = measured && !tooThin;

  const title = !measured
    ? "No verified tasks at this effort — nothing to measure, not a 0% success rate."
    : tooThin
      ? `Only ${row.verifiedTasks} verified task${row.verifiedTasks === 1 ? "" : "s"} at this effort — too few for a rate to mean anything (needs ${MIN_TASKS_FOR_RATE}). ${row.oneShotTasks} of them passed first time.`
      : `${row.oneShotTasks} of ${row.verifiedTasks} tasks started at this effort passed verification without a follow-up edit.`;

  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "flex-end",
        gap: "5px", width: "148px", flexShrink: 0,
        fontFamily: "var(--font-mono)", fontSize: "0.66rem",
        color: showRate ? "var(--text-secondary)" : "var(--text-muted)",
      }}
    >
      {/*
        `title` alone is a mouse-only affordance: it is not exposed on keyboard
        focus, and touch devices have no hover at all. That is tolerable for a
        decorative hint but not here — for a suppressed row the tooltip is the
        only place the reason is written, so an em-dash would otherwise be
        unexplained for anyone not using a pointer.

        The repo's `.sr-only` class (globals.css, as used by ProjectCard and
        SparklineList) puts the same sentence in the accessibility tree as real
        text. Preferred over `aria-label` because ARIA does not reliably name a
        generic `<span>`, so some screen readers would drop it entirely.
      */}
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">
        {showRate ? `${Math.round(row.oneShotRate! * 100)}% 1-shot` : "—"}
      </span>
      {/*
        Hidden from the accessibility tree, like the figure above it: the
        sr-only sentence already states the task count in prose, so exposing
        the pill too would announce the same number twice ("…only 20 verified
        tasks… n=20"). The pill's amber state is a visual encoding of the same
        fact, which the sentence spells out.
      */}
      {measured && (
        <span aria-hidden="true">
          <SampleBadge n={row.verifiedTasks} threshold={MIN_TASKS_FOR_RATE} />
        </span>
      )}
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
