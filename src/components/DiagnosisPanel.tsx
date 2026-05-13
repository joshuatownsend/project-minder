"use client";

import { useEffect, useState } from "react";
import { Activity, Lightbulb } from "lucide-react";
import type {
  DiagnosisReport,
  DiagnosisFinding,
  DiagnosisSeverity,
  SessionOutcome,
} from "@/lib/usage/sessionDiagnosis";
import { formatCost, formatDurationSeconds, formatPct } from "@/lib/format";
import { FindingCard } from "./ui/FindingCard";
import { StatCell } from "./ui/StatCell";
import type { SeverityTone } from "./ui/design";

/** Mapping from this panel's `P0/P1/P2` taxonomy onto the canonical
 *  `crit/high/med` tones consumed by `severityTokens`. */
const TONE_BY_SEVERITY: Record<DiagnosisSeverity, SeverityTone> = {
  P0: "crit",
  P1: "high",
  P2: "med",
};

function outcomeStyle(outcome: SessionOutcome): { label: string; color: string } {
  switch (outcome) {
    case "completed":
      return { label: "Completed", color: "var(--status-active-text)" };
    case "partial":
      return { label: "Partial", color: "var(--accent)" };
    case "abandoned":
      return { label: "Abandoned", color: "var(--text-muted)" };
    case "stuck":
      return { label: "Stuck", color: "var(--status-error-text)" };
  }
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function DiagnosisFindingCard({ finding }: { finding: DiagnosisFinding }) {
  const hasImpact =
    finding.estimatedImpactUsd !== undefined && finding.estimatedImpactUsd > 0;
  return (
    <FindingCard
      tone={TONE_BY_SEVERITY[finding.severity]}
      toneLabel={finding.severity}
      tag={finding.category}
      rightSlot={
        hasImpact ? (
          <span
            title="Approximate dollar impact"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-secondary)",
            }}
          >
            ~{formatCost(finding.estimatedImpactUsd!)}
          </span>
        ) : undefined
      }
    >
      <p
        style={{
          fontSize: "0.82rem",
          color: "var(--text-primary)",
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {finding.finding}
      </p>
      <p
        style={{
          fontSize: "0.78rem",
          color: "var(--text-secondary)",
          margin: 0,
          lineHeight: 1.55,
        }}
      >
        {finding.advice}
      </p>
    </FindingCard>
  );
}


// ── Main panel ────────────────────────────────────────────────────────────────

export function DiagnosisPanel({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<DiagnosisReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/quality`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Preserve the route's structured `{ error: string }` body when
          // available, but fall back to status text when the server
          // returned HTML (Next.js dev error overlay, proxy 502, etc.).
          // Including the raw status code helps the developer find the
          // matching server log line without round-tripping through devtools.
          let detail: string;
          try {
            const body = (await res.json()) as { error?: string };
            detail = body.error ?? res.statusText ?? "Unknown server error";
          } catch {
            detail = res.statusText || "Server returned a non-JSON response";
          }
          // eslint-disable-next-line no-console
          console.error(
            `[DiagnosisPanel] /api/sessions/${sessionId}/quality returned ${res.status}: ${detail}`
          );
          setError(`HTTP ${res.status}: ${detail}`);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as DiagnosisReport;
        if (cancelled) return;
        setReport(data);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error(`[DiagnosisPanel] fetch failed for ${sessionId}`, e);
        // `TypeError: Failed to fetch` is Chromium's signature for
        // network-level failures (server down, DNS, mixed-content). The
        // generic message isn't actionable; tell the user to check the
        // dev server. Other errors keep their message.
        const msg =
          e instanceof TypeError
            ? "Could not reach the server (is the dev server running?)"
            : e instanceof Error
              ? e.message
              : "Unknown error";
        setError(msg);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {[60, 80, 80, 80].map((h, i) => (
          <div
            key={i}
            style={{
              height: `${h}px`,
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius)",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", padding: "20px 0" }}>
        Diagnosis unavailable: {error}
      </p>
    );
  }

  if (!report) return null;

  const outcome = outcomeStyle(report.outcome);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header strip */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
        }}
      >
        <StatCell
          label="Outcome"
          value={<span style={{ color: outcome.color }}>{outcome.label}</span>}
        />
        <StatCell
          label="Cache hit"
          value={formatPct(report.cache.hitRatio)}
          detail={
            report.cache.cacheReadTokens + report.cache.cacheCreateTokens > 0
              ? `${(report.cache.cacheReadTokens / 1000).toFixed(0)}K read · ${(report.cache.cacheCreateTokens / 1000).toFixed(0)}K create`
              : "no cache activity"
          }
        />
        <StatCell
          label="Cache waste"
          value={formatCost(Math.max(report.cache.rebuildWasteUsd, 0))}
          detail={
            report.cache.rebuildWasteUsd < 0
              ? `saved ${formatCost(-report.cache.rebuildWasteUsd)}`
              : undefined
          }
        />
        <StatCell
          label="Peak fill"
          value={formatPct(report.maxContextFill)}
        />
        <StatCell
          label="Idle"
          value={formatDurationSeconds(report.totalIdleSeconds)}
          last
        />
      </div>

      {/* Top advice */}
      {report.topAdvice.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "12px 14px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "0.62rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              fontFamily: "var(--font-body)",
            }}
          >
            <Lightbulb style={{ width: "11px", height: "11px" }} />
            Top advice
          </span>
          <ol
            style={{
              margin: 0,
              paddingLeft: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            {report.topAdvice.map((advice, i) => (
              <li
                key={i}
                style={{
                  fontSize: "0.78rem",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {advice}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Findings */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {report.findings.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "16px",
              background: "var(--status-active-bg)",
              border: "1px solid var(--status-active-border)",
              borderRadius: "var(--radius)",
            }}
          >
            <Activity
              style={{ width: "14px", height: "14px", color: "var(--status-active-text)" }}
            />
            <span
              style={{
                fontSize: "0.82rem",
                color: "var(--status-active-text)",
              }}
            >
              No quality findings — this session looks healthy.
            </span>
          </div>
        ) : (
          report.findings.map((f) => <DiagnosisFindingCard key={f.category} finding={f} />)
        )}
      </div>

      {/* ── Tool errors by category ──────────────────────────────────────── */}
      {report.toolErrorsByCategory && Object.keys(report.toolErrorsByCategory).length > 0 && (
        <div>
          <div
            style={{
              fontSize: "0.68rem", fontWeight: 600, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.06em",
              fontFamily: "var(--font-body)", marginBottom: "8px",
            }}
          >
            Tool errors by category
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {Object.entries(report.toolErrorsByCategory)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, count]) => (
                <div
                  key={cat}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "6px",
                    padding: "4px 10px",
                    background: "var(--status-error-bg)",
                    border: "1px solid var(--status-error-border)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--status-error-text)", fontWeight: 600 }}>{count}×</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)" }}>{cat}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
