"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Info, Activity } from "lucide-react";
import type {
  WasteOptimizerInfo,
  WasteFinding,
  WasteSeverity,
  WasteGrade,
} from "@/lib/scanner/wasteOptimizer";
import type { YieldResult, YieldOutcome } from "@/lib/usage/yieldAnalysis";


interface EfficiencyResponse {
  slug: string;
  waste: WasteOptimizerInfo;
  yieldReport: YieldResult;
  generatedAt: string;
}

interface EfficiencyTabProps {
  slug: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function gradeColor(grade: WasteGrade): string {
  switch (grade) {
    case "A": return "var(--status-active-text)";
    case "B": return "var(--status-active-text)";
    case "C": return "var(--accent)";
    case "D": return "var(--accent)";
    case "F": return "var(--status-error-text)";
  }
}

function severityStyle(severity: WasteSeverity) {
  switch (severity) {
    case "high":
      return {
        bg: "var(--status-error-bg)",
        border: "var(--status-error-border)",
        text: "var(--status-error-text)",
        icon: <AlertOctagon style={{ width: "12px", height: "12px" }} />,
        label: "HIGH",
      };
    case "medium":
      return {
        bg: "var(--accent-bg)",
        border: "var(--accent-border)",
        text: "var(--accent)",
        icon: <AlertTriangle style={{ width: "12px", height: "12px" }} />,
        label: "MEDIUM",
      };
    case "low":
      return {
        bg: "var(--bg-elevated)",
        border: "var(--border-subtle)",
        text: "var(--text-secondary)",
        icon: <Info style={{ width: "12px", height: "12px" }} />,
        label: "LOW",
      };
  }
}

function outcomeColor(o: YieldOutcome): string {
  switch (o) {
    case "productive": return "var(--status-active-text)";
    case "reverted": return "var(--status-error-text)";
    case "abandoned": return "var(--text-muted)";
  }
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function formatTokens(n: number | null): string {
  if (n === null || n === 0) return "—";
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function FindingRow({ finding }: { finding: WasteFinding }) {
  const s = severityStyle(finding.severity);
  return (
    <div
      style={{
        padding: "11px 14px",
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "5px" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: s.text,
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {s.icon}
          {s.label}
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
          {finding.code}
        </span>
        <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          ~{formatTokens(finding.tokensSaveable)} tokens
        </span>
      </div>
      <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>
        {finding.title}
      </div>
      <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "6px", lineHeight: 1.5 }}>
        {finding.explanation}
      </div>
      <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.5, fontStyle: "italic" }}>
        Fix: {finding.fix}
      </div>
    </div>
  );
}

function YieldStatBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div style={{
      flex: 1,
      padding: "12px 14px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
    }}>
      <div style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.1rem", fontFamily: "var(--font-mono)", color, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function EfficiencyTab({ slug }: EfficiencyTabProps) {
  const [data, setData] = useState<EfficiencyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/projects/${encodeURIComponent(slug)}/efficiency`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<EfficiencyResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Computing waste + yield…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--status-error-text)", fontSize: "0.85rem" }}>
        Failed to load efficiency report: {error}
      </div>
    );
  }
  if (!data) return null;

  const { waste, yieldReport } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* ── Waste section ───────────────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
          <span style={{
            fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-muted)",
            fontFamily: "var(--font-body)",
          }}>
            Waste optimizer
          </span>
          <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "8px",
            padding: "4px 10px",
            border: `1px solid ${gradeColor(waste.grade)}`,
            borderRadius: "var(--radius)",
            color: gradeColor(waste.grade),
            fontFamily: "var(--font-mono)", fontSize: "0.72rem", fontWeight: 700,
            letterSpacing: "0.06em",
          }}>
            <Activity style={{ width: "12px", height: "12px" }} />
            Grade {waste.grade}
          </span>
        </div>

        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "10px" }}>
          {waste.counts.total === 0
            ? "No findings — this project's session activity looks clean."
            : `${waste.counts.high} high, ${waste.counts.medium} medium, ${waste.counts.low} low.`}
        </div>

        {waste.findings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {waste.findings.map((f) => (
              <FindingRow key={f.code} finding={f} />
            ))}
          </div>
        )}
      </div>

      {/* ── Yield section ───────────────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
          <span style={{
            fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-muted)",
            fontFamily: "var(--font-body)",
          }}>
            Session yield
          </span>
          <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
        </div>

        {yieldReport.kind === "unavailable" ? (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "12px 0" }}>
            Yield analysis unavailable: {yieldReport.reason}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
              <YieldStatBox
                label="Productive"
                value={yieldReport.report.productive}
                color={outcomeColor("productive")}
              />
              <YieldStatBox
                label="Reverted"
                value={yieldReport.report.reverted}
                color={outcomeColor("reverted")}
              />
              <YieldStatBox
                label="Abandoned"
                value={yieldReport.report.abandoned}
                color={outcomeColor("abandoned")}
              />
              <YieldStatBox
                label="Yield Rate"
                value={formatPct(yieldReport.report.yieldRate)}
                color="var(--text-primary)"
              />
              <YieldStatBox
                label="$/Shipped Commit"
                value={
                  yieldReport.report.dollarsPerShippedCommit !== null
                    ? formatUsd(yieldReport.report.dollarsPerShippedCommit)
                    : "—"
                }
                color="var(--text-primary)"
              />
            </div>

            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
              {yieldReport.report.totalSessions} sessions classified by overlap with main-branch commits.
              {" "}Reverted = ≥50% of attributed commits later reverted.
              {" "}Abandoned = no commits attributed to the session window.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
