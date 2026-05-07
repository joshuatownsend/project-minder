"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { SampleBadge } from "./SampleBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { msLabel, defaultSince } from "@/lib/format";
import type { ToolLatencyResult } from "@/lib/db/otelQueries";

interface Props {
  since?: string;
  sessionId?: string;
}

export function ToolLatencyCard({ since, sessionId }: Props) {
  const sinceParam = since ?? defaultSince();
  const params = new URLSearchParams({ since: sinceParam });
  if (sessionId) params.set("sessionId", sessionId);

  const { data, loading, error } = useReportFetch<ToolLatencyResult>(
    `/api/telemetry/tool-latency?${params}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error || !data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {error ? `Error: ${error}` : "No latency data — install OTEL and restart Claude Code."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {/* Header row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 42px", gap: "4px", paddingBottom: "6px", borderBottom: "1px solid var(--border-subtle)" }}>
        {["Tool", "p50", "p95", "max", "n"].map((h) => (
          <span key={h} style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {h}
          </span>
        ))}
      </div>
      {data.tools.map((tool) => {
        const slow = tool.p95 >= 10_000;
        const fast = tool.p50 < 500;
        return (
          <div key={tool.name} style={{
            display: "grid",
            gridTemplateColumns: "1fr 60px 60px 60px 42px",
            gap: "4px",
            padding: "3px 0",
            background: slow ? "rgba(239,68,68,0.05)" : "transparent",
            borderRadius: "2px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              {fast && <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "var(--status-active-text)", flexShrink: 0, display: "inline-block" }} />}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tool.name}
              </span>
            </div>
            {[tool.p50, tool.p95, tool.max].map((val, i) => (
              <span key={i} style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                color: i === 1 && slow ? "var(--status-error-text)" : "var(--text-secondary)",
              }}>
                {msLabel(val)}
              </span>
            ))}
            <SampleBadge n={tool.n} threshold={5} />
          </div>
        );
      })}
    </div>
  );
}
