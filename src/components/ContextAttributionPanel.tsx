"use client";

import { useEffect, useState } from "react";
import { PieChart, Scissors } from "lucide-react";
import {
  CONTEXT_CATEGORIES,
  CONTEXT_CATEGORY_LABELS,
  type ContextAttributionReport,
  type ContextCategory,
} from "@/lib/usage/contextAttribution";
import { StatCell } from "./ui/StatCell";

// Per-session view of what filled the context window. Complements the
// portfolio-wide, pre-flight estimate on /stats (`contextOverhead.ts`);
// this one is retrospective and per-turn.

const CATEGORY_COLOR: Record<ContextCategory, string> = {
  userText: "var(--chart-1)",
  attachedContext: "var(--chart-2)",
  assistantText: "var(--chart-3)",
  thinking: "var(--chart-4)",
  toolInput: "var(--chart-5)",
  toolOutput: "var(--accent)",
};

function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n / 1_000)}k`;
}

/** Horizontal 100%-stacked bar of one category set. */
function StackedBar({
  totals,
  total,
  height = 10,
}: {
  totals: Record<ContextCategory, number>;
  total: number;
  height?: number;
}) {
  if (total <= 0) {
    return (
      <div
        style={{ height, borderRadius: 999, background: "var(--surface-2)" }}
        aria-hidden
      />
    );
  }
  return (
    <div style={{ display: "flex", height, borderRadius: 999, overflow: "hidden" }}>
      {CONTEXT_CATEGORIES.filter((c) => totals[c] > 0).map((c) => (
        <div
          key={c}
          style={{ width: `${(totals[c] / total) * 100}%`, background: CATEGORY_COLOR[c] }}
          title={`${CONTEXT_CATEGORY_LABELS[c]} — ${fmtTokens(totals[c])} tokens (${((totals[c] / total) * 100).toFixed(1)}%)`}
        />
      ))}
    </div>
  );
}

export function ContextAttributionPanel({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<ContextAttributionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${sessionId}/context-attribution`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((json: ContextAttributionReport) => {
        if (!controller.signal.aborted) setReport(json);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  if (loading) {
    return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Analysing context…</p>;
  }
  // An error must NOT render as an empty chart — "this session used no
  // context" is a wrong answer, not a missing one.
  if (error) {
    return (
      <p style={{ color: "var(--status-error-text)", fontSize: 13 }}>
        Could not analyse this session&rsquo;s context: {error}
      </p>
    );
  }
  if (!report || report.turns.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        No attributable turns in this session.
      </p>
    );
  }

  const { totals, attributedTotal, dominantCategory, dominantShare } = report;
  const peakTurnTokens = Math.max(...report.turns.map((t) => t.addedTotal), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PieChart size={16} style={{ color: "var(--text-muted)" }} />
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Context attribution</h3>
      </div>

      {dominantCategory && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          <strong>{CONTEXT_CATEGORY_LABELS[dominantCategory]}</strong> accounted for{" "}
          <strong>{dominantShare.toFixed(0)}%</strong> of the context this session put into
          the window.
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <StatCell label="Attributed" value={fmtTokens(attributedTotal)} detail="from transcript" />
        <StatCell
          label="Peak window"
          value={report.peakMeasuredTokens === null ? "—" : fmtTokens(report.peakMeasuredTokens)}
          detail={
            report.peakMeasuredTokens === null
              ? "no usage data"
              : `${report.peakContextPercent.toFixed(0)}% of ${fmtTokens(report.contextWindowTokens)}`
          }
        />
        <StatCell label="Compactions" value={report.compactionCount} detail="window resets" />
        <StatCell label="Turns" value={report.turns.length} />
      </div>

      {/* Whole-session composition */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <StackedBar totals={totals} total={attributedTotal} height={14} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {CONTEXT_CATEGORIES.filter((c) => totals[c] > 0).map((c) => (
            <span
              key={c}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: CATEGORY_COLOR[c],
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "var(--text-secondary)" }}>
                {CONTEXT_CATEGORY_LABELS[c]}
              </span>
              <span style={{ color: "var(--text-muted)" }}>
                {fmtTokens(totals[c])} · {((totals[c] / attributedTotal) * 100).toFixed(0)}%
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Per-segment breakdown, split at compaction boundaries. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {report.segments
          .filter((s) => s.attributedTotal > 0)
          .map((seg) => (
            <div key={seg.index} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {seg.index > 0 && <Scissors size={11} />}
                  {seg.index === 0
                    ? `Turns ${seg.startTurn}–${seg.endTurn}`
                    : `After compaction ${seg.index} · turns ${seg.startTurn}–${seg.endTurn}`}
                </span>
                <span
                  title={
                    seg.unattributedTokens !== null && seg.attributedAtPeak !== null
                      ? `At peak fill (${fmtTokens(seg.peakMeasuredTokens ?? 0)}), ` +
                        `${fmtTokens(seg.attributedAtPeak)} was attributable to the transcript; ` +
                        `the remaining ${fmtTokens(seg.unattributedTokens)} is harness-injected ` +
                        `(system prompt, tool definitions, CLAUDE.md, skills).`
                      : undefined
                  }
                >
                  {fmtTokens(seg.attributedTotal)} attributed
                  {seg.unattributedTokens !== null && seg.unattributedTokens > 0 && (
                    <> · {fmtTokens(seg.unattributedTokens)} unattributed</>
                  )}
                </span>
              </div>
              <StackedBar totals={seg.totals} total={seg.attributedTotal} />
            </div>
          ))}
      </div>

      {/* Per-turn contribution. Bars are relative to the largest turn, so
          the shape shows WHERE the spikes were, not absolute fill. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Per-turn contribution
        </span>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 56 }}>
          {report.turns.map((t) => (
            <div
              key={t.turnIndex}
              title={`Turn ${t.turnIndex} (${t.role}) — ${fmtTokens(t.addedTotal)} tokens${
                t.afterCompaction ? " · first turn after compaction" : ""
              }`}
              style={{
                flex: 1,
                minWidth: 1,
                height: `${Math.max(2, (t.addedTotal / peakTurnTokens) * 100)}%`,
                background: t.afterCompaction
                  ? "var(--status-error-text)"
                  : CATEGORY_COLOR[
                      CONTEXT_CATEGORIES.reduce((best, c) =>
                        t.added[c] > t.added[best] ? c : best
                      )
                    ],
                opacity: t.addedTotal === 0 ? 0.25 : 1,
              }}
            />
          ))}
        </div>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
        Token counts are estimated from message sizes (~4 bytes per token); per-turn window
        totals are measured. The gap between them — the system prompt, tool definitions,
        CLAUDE.md, and skill bodies — is shown as <em>unattributed</em>, because those are
        injected by Claude Code and never appear in the transcript. Subagent turns are
        excluded: they run in their own context window.
      </p>
    </div>
  );
}
