"use client";

import { useEffect, useState } from "react";
import type { FacetsAggregate } from "@/lib/scanner/claudeFacets";

interface FeedbackAggResult extends FacetsAggregate {
  period: string;
  projectSlug: string | null;
}

function DistributionBar({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)", width: "160px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label.replace(/_/g, " ")}
      </span>
      <div style={{ flex: 1, height: "6px", background: "var(--bg-elevated)", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", borderRadius: "3px", transition: "width 0.3s" }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", width: "24px", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function Section({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const max = entries[0][1];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{title}</span>
      {entries.map(([k, v]) => <DistributionBar key={k} label={k} value={v} max={max} />)}
    </div>
  );
}

export function FeedbackAggregate({ period, projectSlug }: { period: string; projectSlug?: string | null }) {
  const [data, setData] = useState<FeedbackAggResult | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(false);
    const url = `/api/feedback?period=${period}${projectSlug ? `&project=${projectSlug}` : ""}`;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json() as Promise<FeedbackAggResult>;
      })
      .then(setData)
      .catch(() => { setData(null); setError(true); })
      .finally(() => setLoading(false));
  }, [period, projectSlug]);

  if (loading) return <p style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Loading…</p>;
  if (error) return <p style={{ fontSize: "0.72rem", color: "var(--status-error-text)" }}>Failed to load feedback data.</p>;
  if (!data || data.sessionCount === 0) {
    return <p style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>No feedback recorded for this period.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{data.sessionCount} sessions with feedback</span>
      <Section title="Outcome" counts={data.outcomeCounts} />
      <Section title="Helpfulness" counts={data.helpfulnessCounts} />
      <Section title="Satisfaction" counts={data.satisfactionCounts} />
      {Object.keys(data.frictionCounts).length > 0 && <Section title="Friction" counts={data.frictionCounts} />}
      {Object.keys(data.sessionTypeCounts).length > 0 && <Section title="Session type" counts={data.sessionTypeCounts} />}
    </div>
  );
}
