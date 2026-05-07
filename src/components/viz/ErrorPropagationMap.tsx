"use client";

import * as d3 from "d3";
import { D3Container, Axes } from "./D3Container";
import { depthColor } from "./agentPalette";
import { useReportFetch } from "@/hooks/useReportFetch";
import type { ErrorReport, DepthBucket } from "@/lib/usage/errorPropagation";

interface Props {
  slug: string;
}

export function ErrorPropagationMap({ slug }: Props) {
  const { data, loading, error } = useReportFetch<ErrorReport>(
    `/api/projects/${slug}/error-propagation`
  );

  if (loading) {
    return <div style={{ height: "240px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />;
  }

  if (error) {
    return <p style={{ fontSize: "0.8rem", color: "var(--status-error-text)" }}>{error}</p>;
  }

  if (!data || data.summary.sessionCount === 0 || data.summary.totalErrors === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)" }}>
        <p style={{ fontSize: "0.8rem" }}>
          {data?.summary.sessionCount
            ? `No errors recorded across ${data.summary.sessionCount} sessions.`
            : "No sessions with subagent data found."}
        </p>
      </div>
    );
  }

  const { summary, byDepth, topAgents, byTool } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>

      {/* Summary row */}
      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
        {[
          { label: "Sessions", value: summary.sessionCount },
          { label: "Agent nodes", value: summary.totalNodes },
          { label: "Errors", value: summary.totalErrors, accent: "error" },
          { label: "Error rate", value: `${(summary.errorRate * 100).toFixed(1)}%`, accent: summary.errorRate > 0.1 ? "error" : undefined },
        ].map((s) => (
          <div key={s.label} style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "80px" }}>
            <span style={{ fontSize: "0.6rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>{s.label}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.1rem", fontWeight: 600, color: s.accent === "error" ? "var(--status-error-text)" : "var(--text-primary)" }}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* Errors by depth bar chart */}
      {byDepth.length > 0 && (
        <section>
          <h3 style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "8px" }}>
            Errors by hierarchy depth
          </h3>
          <DepthBarChart buckets={byDepth} />
        </section>
      )}

      {/* Top error-prone agents */}
      {topAgents.length > 0 && (
        <section>
          <h3 style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "8px" }}>
            Top error-prone agents
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {topAgents.slice(0, 8).map((a) => (
              <div key={a.name} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-secondary)", width: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                <div style={{ flex: 1, height: "6px", background: "var(--bg-elevated)", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${a.rate * 100}%`, background: "var(--status-error-text)", borderRadius: "3px" }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)", width: "60px", textAlign: "right" }}>{a.errors}/{a.total}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tool breakdown */}
      {byTool.length > 0 && (
        <section>
          <h3 style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "8px" }}>
            Tool error breakdown
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {byTool.slice(0, 10).map((t) => (
              <div key={t.tool} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-secondary)", width: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.tool}</span>
                <div style={{ flex: 1, height: "6px", background: "var(--bg-elevated)", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${t.total > 0 ? (t.errors / t.total) * 100 : 0}%`, background: "var(--status-error-text)", opacity: 0.7, borderRadius: "3px" }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)", width: "60px", textAlign: "right" }}>{t.errors}e / {t.total}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DepthBarChart({ buckets }: { buckets: DepthBucket[] }) {
  const maxRate = Math.max(...buckets.map((b) => b.rate), 0.01);
  const yScale = d3.scaleLinear().domain([0, maxRate]).range([200, 0]).nice();

  return (
    <D3Container height={240} margin={{ top: 12, right: 12, bottom: 32, left: 48 }}>
      {({ width, height, showTooltip, hideTooltip }) => {
        const xS = d3.scaleBand()
          .domain(buckets.map((b) => String(b.depth)))
          .range([0, width])
          .padding(0.25);
        const barW = xS.bandwidth();

        return (
          <g>
            <Axes xScale={xS as unknown as Parameters<typeof Axes>[0]["xScale"]} yScale={yScale} width={width} height={height} xLabel="Depth" yLabel="Error rate" tickCountX={buckets.length} tickCountY={4} />
            {buckets.map((b) => {
              const x = xS(String(b.depth)) ?? 0;
              const barH = height - yScale(b.rate);
              return (
                <rect
                  key={b.depth}
                  x={x}
                  y={yScale(b.rate)}
                  width={barW}
                  height={barH}
                  fill={depthColor(b.depth)}
                  opacity={0.85}
                  rx={2}
                  style={{ cursor: "default" }}
                  onMouseEnter={(e) => {
                    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
                    showTooltip(r.left + r.width / 2, r.top - 8,
                      `Depth ${b.depth} · ${b.errors}/${b.total} errors (${(b.rate * 100).toFixed(1)}%)`);
                  }}
                  onMouseLeave={hideTooltip}
                />
              );
            })}
          </g>
        );
      }}
    </D3Container>
  );
}
