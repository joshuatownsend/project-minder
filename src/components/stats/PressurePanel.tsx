"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import type { PressureResult } from "@/lib/db/otelQueries";

interface Props {
  since?: string;
}

function CounterBadge({ label, value, variant }: { label: string; value: number; variant: "error" | "warn" | "neutral" }) {
  const colors = {
    error:   { bg: "rgba(239,68,68,0.1)",  border: "rgba(239,68,68,0.3)",  text: "var(--status-error-text)" },
    warn:    { bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.3)", text: "var(--accent)" },
    neutral: { bg: "var(--bg-surface)",    border: "var(--border-subtle)", text: "var(--text-secondary)" },
  }[variant];

  return (
    <div style={{
      padding: "10px 14px",
      borderRadius: "var(--radius)",
      background: value > 0 ? colors.bg : "var(--bg-surface)",
      border: `1px solid ${value > 0 ? colors.border : "var(--border-subtle)"}`,
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.6rem", fontWeight: 700, lineHeight: 1, color: value > 0 ? colors.text : "var(--text-muted)" }}>
        {value}
      </span>
    </div>
  );
}

export function PressurePanel({ since }: Props) {
  const sinceParam = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, loading, error } = useReportFetch<PressureResult>(
    `/api/telemetry/pressure?since=${encodeURIComponent(sinceParam)}`,
  );

  if (loading) return <Skeleton className="h-28" />;

  if (error) {
    return (
      <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        Error: {error}
      </div>
    );
  }

  const counts = data ?? { apiErrorCount: 0, compactionCount: 0, retryExhaustionCount: 0, retryThreshold: 10, lastErrors: [], hasData: false };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Counter row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
        <CounterBadge label="API Errors" value={counts.apiErrorCount} variant="error" />
        <CounterBadge label="Retry Exhausted" value={counts.retryExhaustionCount} variant="error" />
        <CounterBadge label="Compactions" value={counts.compactionCount} variant="neutral" />
      </div>

      {/* Last errors */}
      {counts.lastErrors.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Recent errors
          </span>
          {counts.lastErrors.map((e, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "110px 40px 1fr",
              gap: "8px",
              alignItems: "baseline",
              padding: "3px 0",
              borderBottom: "1px solid var(--border-subtle)",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}>
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}>
                {e.attempt != null ? `×${e.attempt}` : ""}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--status-error-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.error ?? undefined}>
                {e.error ?? e.event}
              </span>
            </div>
          ))}
        </div>
      )}

      {!counts.hasData && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          No pressure events in this period.
        </div>
      )}
    </div>
  );
}
