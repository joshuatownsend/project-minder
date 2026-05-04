"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Info, Activity, Lightbulb } from "lucide-react";
import type {
  DiagnosisReport,
  DiagnosisFinding,
  DiagnosisSeverity,
  SessionOutcome,
} from "@/lib/usage/sessionDiagnosis";

// ── Severity styling ──────────────────────────────────────────────────────────

function severityStyle(severity: DiagnosisSeverity): {
  bg: string;
  border: string;
  text: string;
  icon: React.ReactNode;
} {
  switch (severity) {
    case "P0":
      return {
        bg: "var(--status-error-bg)",
        border: "var(--status-error-border)",
        text: "var(--status-error-text)",
        icon: <AlertOctagon style={{ width: "12px", height: "12px" }} />,
      };
    case "P1":
      return {
        bg: "var(--accent-bg)",
        border: "var(--accent-border)",
        text: "var(--accent)",
        icon: <AlertTriangle style={{ width: "12px", height: "12px" }} />,
      };
    case "P2":
    default:
      return {
        bg: "var(--bg-elevated)",
        border: "var(--border-subtle)",
        text: "var(--text-secondary)",
        icon: <Info style={{ width: "12px", height: "12px" }} />,
      };
  }
}

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

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function formatPct(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function formatUsd(n: number): string {
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function FindingCard({ finding }: { finding: DiagnosisFinding }) {
  const style = severityStyle(finding.severity);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "11px 14px",
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: style.text,
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {style.icon}
          {finding.severity}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {finding.category}
        </span>
        {finding.estimatedImpactUsd !== undefined && finding.estimatedImpactUsd > 0 && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-secondary)",
            }}
            title="Approximate dollar impact"
          >
            ~{formatUsd(finding.estimatedImpactUsd)}
          </span>
        )}
      </div>
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
    </div>
  );
}

function HeaderStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "10px 14px",
        borderRight: "1px solid var(--border-subtle)",
        flex: "1 1 100px",
        minWidth: "100px",
      }}
    >
      <span
        style={{
          fontSize: "0.6rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
      {detail && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-muted)",
          }}
        >
          {detail}
        </span>
      )}
    </div>
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
        <HeaderStat
          label="Outcome"
          value={outcome.label}
          detail={undefined}
        />
        <HeaderStat
          label="Cache hit"
          value={formatPct(report.cache.hitRatio)}
          detail={
            report.cache.cacheReadTokens + report.cache.cacheCreateTokens > 0
              ? `${(report.cache.cacheReadTokens / 1000).toFixed(0)}K read · ${(report.cache.cacheCreateTokens / 1000).toFixed(0)}K create`
              : "no cache activity"
          }
        />
        <HeaderStat
          label="Cache waste"
          value={formatUsd(Math.max(report.cache.rebuildWasteUsd, 0))}
          detail={
            report.cache.rebuildWasteUsd < 0
              ? `saved ${formatUsd(-report.cache.rebuildWasteUsd)}`
              : undefined
          }
        />
        <HeaderStat
          label="Peak fill"
          value={formatPct(report.maxContextFill)}
        />
        <HeaderStat
          label="Idle"
          value={formatDuration(report.totalIdleSeconds)}
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
          report.findings.map((f) => <FindingCard key={f.category} finding={f} />)
        )}
      </div>
    </div>
  );
}
