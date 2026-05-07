"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { SampleBadge } from "./SampleBadge";
import { Skeleton } from "@/components/ui/skeleton";
import type { EditAcceptanceResult } from "@/lib/db/otelQueries";

interface Props {
  since?: string; // ISO-8601, defaults to last 7 days
  sessionId?: string;
}

function AcceptBar({ accepted, rejected }: { accepted: number; rejected: number }) {
  const total = accepted + rejected;
  if (total === 0) return null;
  const pct = Math.round((accepted / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}>
      <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "var(--border-subtle)", overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: "3px",
          background: pct >= 80 ? "var(--status-active-text)" : pct >= 50 ? "var(--accent)" : "var(--status-error-text)",
        }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)", minWidth: "30px" }}>
        {pct}%
      </span>
    </div>
  );
}

export function EditAcceptanceCard({ since, sessionId }: Props) {
  const sinceParam = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ since: sinceParam });
  if (sessionId) params.set("sessionId", sessionId);

  const { data, loading, error } = useReportFetch<EditAcceptanceResult>(
    `/api/telemetry/edit-acceptance?${params}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error || !data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {error ? `Error: ${error}` : "No edit decisions recorded yet."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <SampleBadge n={data.totalN} threshold={10} />
      </div>
      {data.tools.map((tool) => (
        <div key={tool.name} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              {tool.name}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
              {tool.accepted}✓ {tool.rejected}✗
            </span>
          </div>
          <AcceptBar accepted={tool.accepted} rejected={tool.rejected} />
        </div>
      ))}
    </div>
  );
}
