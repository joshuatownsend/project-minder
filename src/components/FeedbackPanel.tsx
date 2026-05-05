"use client";

import { useEffect, useState } from "react";
import type { FacetData } from "@/lib/scanner/claudeFacets";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "12px", padding: "6px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", width: "140px", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: "0.78rem", color: "var(--text-primary)", flex: 1 }}>{value}</span>
    </div>
  );
}

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {entries.map(([k, v]) => (
        <span key={k} style={{
          fontSize: "0.68rem", padding: "2px 8px",
          background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
          borderRadius: "10px", color: "var(--text-secondary)",
        }}>
          {k} {v > 1 ? `(${v})` : ""}
        </span>
      ))}
    </div>
  );
}

export function FeedbackPanel({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<FacetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setError(null);
    fetch(`/api/sessions/${sessionId}/feedback`)
      .then(async (r) => {
        if (r.status === 404) { setNotFound(true); return; }
        if (!r.ok) { setError(`HTTP ${r.status}`); return; }
        setData(await r.json() as FacetData);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>;
  if (notFound) return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", padding: "24px 0" }}>No feedback recorded for this session.</p>;
  if (error) return <p style={{ fontSize: "0.78rem", color: "var(--status-error-text)", padding: "24px 0" }}>Error loading feedback: {error}</p>;
  if (!data) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {data.underlying_goal && <Row label="Goal" value={data.underlying_goal} />}
      {data.outcome && <Row label="Outcome" value={data.outcome.replace(/_/g, " ")} />}
      {data.claude_helpfulness && <Row label="Helpfulness" value={data.claude_helpfulness.replace(/_/g, " ")} />}
      {data.session_type && <Row label="Session type" value={data.session_type.replace(/_/g, " ")} />}
      {data.user_satisfaction_counts && Object.keys(data.user_satisfaction_counts).length > 0 && (
        <Row label="Satisfaction" value={<Counts counts={data.user_satisfaction_counts} />} />
      )}
      {data.friction_counts && Object.keys(data.friction_counts).length > 0 && (
        <Row label="Friction" value={<Counts counts={data.friction_counts} />} />
      )}
      {data.friction_detail && <Row label="Friction detail" value={data.friction_detail} />}
      {data.primary_success && <Row label="Primary success" value={data.primary_success.replace(/_/g, " ")} />}
      {data.brief_summary && <Row label="Summary" value={data.brief_summary} />}
    </div>
  );
}
