"use client";

import { useState } from "react";
import { useReportFetch } from "@/hooks/useReportFetch";
import { SampleBadge } from "./SampleBadge";
import { Skeleton } from "@/components/ui/skeleton";
import type { CacheEfficiencyResult, Period } from "@/lib/db/otelQueries";
import { PeriodToggle } from "./PeriodToggle";

const TARGET_HIT_RATE = 0.7;

function hitRateColor(rate: number): string {
  if (rate >= TARGET_HIT_RATE) return "var(--status-active-text)";
  if (rate >= 0.4)              return "var(--accent)";
  return "var(--status-error-text)";
}

export function CacheEfficiencyCard() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data, loading, error } = useReportFetch<CacheEfficiencyResult>(
    `/api/telemetry/cache-efficiency?period=${period}`,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <PeriodToggle value={period} onChange={setPeriod} />

      {loading && <Skeleton className="h-24" />}

      {!loading && (error || !data?.hasData) && (
        <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
          {error ? `Error: ${error}` : "No token data yet — run a Claude Code session with OTEL installed."}
        </div>
      )}

      {!loading && data?.hasData && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "2.2rem",
              fontWeight: 700,
              color: hitRateColor(data.hitRate),
              lineHeight: 1,
            }}>
              {Math.round(data.hitRate * 100)}%
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
              cache hit rate
            </span>
            <div style={{ marginLeft: "auto" }}>
              <SampleBadge n={Math.round(data.totalBillable / 1000)} threshold={10} />
            </div>
          </div>

          <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            target: {TARGET_HIT_RATE * 100}% — {Math.round(data.totalBillable).toLocaleString()} billable tokens
          </div>

          {data.daily.length > 1 && (
            <div style={{ position: "relative", height: "32px" }}>
              <div style={{
                position: "absolute",
                top: `${(1 - TARGET_HIT_RATE) * 32}px`,
                left: 0, right: 0,
                height: "1px",
                borderTop: "1px dashed rgba(245,158,11,0.4)",
              }} />
              <div style={{ display: "flex", gap: "2px", alignItems: "flex-end", height: "100%" }}>
                {data.daily.map((d) => (
                  <div key={d.day} title={`${d.day}: ${Math.round(d.hitRate * 100)}%`} style={{
                    flex: 1,
                    height: `${Math.max(2, d.hitRate * 32)}px`,
                    background: hitRateColor(d.hitRate),
                    borderRadius: "1px",
                    opacity: 0.7,
                    minWidth: "2px",
                  }} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
