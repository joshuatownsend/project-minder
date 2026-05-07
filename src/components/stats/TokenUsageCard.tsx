"use client";

import { useState } from "react";
import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import type { TokenUsageResult } from "@/lib/db/otelQueries";

type Period = "today" | "7d" | "30d";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

const SEGMENT_COLORS: Record<string, string> = {
  input:         "var(--info)",
  output:        "var(--status-active-text)",
  cacheRead:     "var(--accent)",
  cacheCreation: "var(--text-muted)",
};

const SEGMENT_LABELS: Record<string, string> = {
  input: "Input", output: "Output", cacheRead: "Cache hit", cacheCreation: "Cache write",
};

export function TokenUsageCard() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data, loading, error } = useReportFetch<TokenUsageResult>(
    `/api/telemetry/token-usage?period=${period}`,
  );

  const maxTotal = data?.daily.reduce((m, d) => Math.max(m, d.input + d.output + d.cacheRead + d.cacheCreation), 1) ?? 1;

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
          {/* Totals row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
            {(["input", "output", "cacheRead", "cacheCreation"] as const).map((k) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <div style={{ width: "6px", height: "6px", borderRadius: "2px", background: SEGMENT_COLORS[k], flexShrink: 0 }} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
                    {SEGMENT_LABELS[k]}
                  </span>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.9rem", fontWeight: 700, color: "var(--text-primary)" }}>
                  {formatTokens(data.totals[k])}
                </span>
              </div>
            ))}
          </div>

          {/* Daily stacked bars */}
          {data.daily.length > 0 && (
            <div style={{ display: "flex", gap: "3px", alignItems: "flex-end", height: "48px" }}>
              {data.daily.map((d) => {
                const total = d.input + d.output + d.cacheRead + d.cacheCreation;
                const heightPct = total / maxTotal;
                return (
                  <div key={d.day} title={d.day} style={{
                    flex: 1,
                    height: `${Math.max(2, heightPct * 48)}px`,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    borderRadius: "2px",
                    minWidth: "2px",
                  }}>
                    {(["cacheCreation", "cacheRead", "output", "input"] as const).map((k) => {
                      const seg = total > 0 ? (d[k] / total) * 100 : 0;
                      return seg > 0 ? (
                        <div key={k} style={{ height: `${seg}%`, background: SEGMENT_COLORS[k] }} />
                      ) : null;
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
