"use client";

import { useState } from "react";
import { useReportFetch } from "@/hooks/useReportFetch";
import { SampleBadge } from "./SampleBadge";
import { Skeleton } from "@/components/ui/skeleton";
import type { CacheEfficiencyResult } from "@/lib/db/otelQueries";

type Period = "today" | "7d" | "30d";

const TARGET_HIT_RATE = 0.7; // 70% target line

export function CacheEfficiencyCard() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data, loading, error } = useReportFetch<CacheEfficiencyResult>(
    `/api/telemetry/cache-efficiency?period=${period}`,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Period toggle */}
      <div style={{ display: "flex", gap: "4px" }}>
        {(["today", "7d", "30d"] as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            padding: "2px 8px",
            borderRadius: "4px",
            border: `1px solid ${period === p ? "var(--accent)" : "var(--border-subtle)"}`,
            background: period === p ? "rgba(245,158,11,0.1)" : "transparent",
            color: period === p ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
          }}>{p}</button>
        ))}
      </div>

      {loading && <Skeleton className="h-24" />}

      {!loading && (error || !data?.hasData) && (
        <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
          {error ? `Error: ${error}` : "No token data yet — run a Claude Code session with OTEL installed."}
        </div>
      )}

      {!loading && data?.hasData && (
        <>
          {/* Big hit-rate number */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "2.2rem",
              fontWeight: 700,
              color: data.hitRate >= TARGET_HIT_RATE ? "var(--status-active-text)" : data.hitRate >= 0.4 ? "var(--accent)" : "var(--status-error-text)",
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

          {/* Sparkline with target line */}
          {data.daily.length > 1 && (
            <div style={{ position: "relative", height: "32px" }}>
              {/* Target line */}
              <div style={{
                position: "absolute",
                top: `${(1 - TARGET_HIT_RATE) * 32}px`,
                left: 0, right: 0,
                height: "1px",
                background: "rgba(245,158,11,0.3)",
                borderTop: "1px dashed rgba(245,158,11,0.4)",
              }} />
              {/* Bars */}
              <div style={{ display: "flex", gap: "2px", alignItems: "flex-end", height: "100%" }}>
                {data.daily.map((d) => (
                  <div key={d.day} title={`${d.day}: ${Math.round(d.hitRate * 100)}%`} style={{
                    flex: 1,
                    height: `${Math.max(2, d.hitRate * 32)}px`,
                    background: d.hitRate >= TARGET_HIT_RATE ? "var(--status-active-text)" : d.hitRate >= 0.4 ? "var(--accent)" : "var(--status-error-text)",
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
