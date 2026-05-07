"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import type { HookActivityResult } from "@/lib/db/otelQueries";

interface Props {
  since?: string;
}

function msLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function HookActivityCard({ since }: Props) {
  const sinceParam = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, loading, error } = useReportFetch<HookActivityResult>(
    `/api/telemetry/hook-activity?since=${encodeURIComponent(sinceParam)}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error || !data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {error ? `Error: ${error}` : "No hooks fired yet."}
      </div>
    );
  }

  const maxFires = Math.max(...data.hooks.map((h) => h.fires), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px", gap: "4px", paddingBottom: "6px", borderBottom: "1px solid var(--border-subtle)" }}>
        {["Hook", "Fires", "p50", "p95"].map((h) => (
          <span key={h} style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {h}
          </span>
        ))}
      </div>
      {data.hooks.map((hook) => (
        <div key={hook.name} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "3px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px", gap: "4px", alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hook.name}>
              {hook.name}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{
                height: "5px",
                width: `${Math.round((hook.fires / maxFires) * 64)}px`,
                background: "var(--info)",
                borderRadius: "2px",
                minWidth: "2px",
              }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-secondary)" }}>
                {hook.fires}
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {msLabel(hook.p50DurationMs)}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {msLabel(hook.p95DurationMs)}
            </span>
          </div>
        </div>
      ))}
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", marginTop: "4px" }}>
        {data.totalFires} total executions
      </div>
    </div>
  );
}
