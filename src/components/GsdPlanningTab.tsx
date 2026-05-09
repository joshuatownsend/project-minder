"use client";

import { useState, useEffect } from "react";
import type { GsdPlanningInfo, GsdPhaseEntry } from "@/lib/types";

function StatusPill({ status }: { status: GsdPhaseEntry["status"] }) {
  const colors: Record<GsdPhaseEntry["status"], { bg: string; text: string }> = {
    completed:   { bg: "rgba(34,197,94,0.15)",  text: "#22c55e" },
    "in-progress": { bg: "rgba(234,179,8,0.15)", text: "#eab308" },
    pending:     { bg: "rgba(148,163,184,0.12)", text: "var(--text-muted)" },
  };
  const { bg, text } = colors[status];
  const label = status === "in-progress" ? "In Progress" : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span style={{
      fontSize: "0.64rem", fontFamily: "var(--font-body)", fontWeight: 600,
      letterSpacing: "0.05em", textTransform: "uppercase",
      background: bg, color: text,
      borderRadius: "3px", padding: "2px 6px",
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function PhaseRow({ phase }: { phase: GsdPhaseEntry }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
      padding: "10px 14px",
      borderBottom: "1px solid var(--border-subtle)",
    }}>
      {/* Phase number */}
      <span style={{
        fontSize: "0.65rem", fontFamily: "var(--font-mono)",
        color: "var(--text-muted)", minWidth: "20px", flexShrink: 0,
      }}>
        {phase.number}
      </span>

      {/* Phase name */}
      <span style={{
        fontSize: "0.8rem", fontFamily: "var(--font-body)",
        color: phase.status === "pending" ? "var(--text-muted)" : "var(--text-primary)",
        flex: 1, minWidth: "120px",
        textDecoration: phase.status === "completed" ? "line-through" : "none",
        opacity: phase.status === "pending" ? 0.7 : 1,
      }}>
        {phase.name}
      </span>

      {/* Chips */}
      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
        {phase.tokenBudget !== undefined && (
          <span style={{
            fontSize: "0.64rem", fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "3px", padding: "2px 6px",
            whiteSpace: "nowrap",
          }}>
            {(phase.tokenBudget / 1000).toFixed(0)}k tok
          </span>
        )}
        {phase.costUsd !== undefined && (
          <span style={{
            fontSize: "0.64rem", fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "rgba(var(--accent-rgb,234,179,8),0.1)",
            border: "1px solid rgba(var(--accent-rgb,234,179,8),0.25)",
            borderRadius: "3px", padding: "2px 6px",
            whiteSpace: "nowrap",
          }}>
            ${phase.costUsd.toFixed(2)}
          </span>
        )}
        <StatusPill status={phase.status} />
      </div>
    </div>
  );
}

function CompletionBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div style={{
        flex: 1, height: "6px",
        background: "var(--bg-elevated)",
        borderRadius: "3px", overflow: "hidden",
      }}>
        <div style={{
          height: "100%", width: `${pct}%`,
          background: pct === 100 ? "#22c55e" : "var(--accent)",
          borderRadius: "3px",
          transition: "width 0.4s ease",
        }} />
      </div>
      <span style={{
        fontSize: "0.72rem", fontFamily: "var(--font-mono)",
        color: "var(--text-secondary)", whiteSpace: "nowrap",
      }}>
        {completed}/{total} phases ({pct}%)
      </span>
    </div>
  );
}

export function GsdPlanningTab({ slug }: { slug: string }) {
  const [data, setData] = useState<GsdPlanningInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${encodeURIComponent(slug)}/gsd-planning`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<GsdPlanningInfo>;
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load planning data");
        setLoading(false);
      });
  }, [slug]);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{
            height: "40px", borderRadius: "var(--radius)",
            background: "var(--bg-elevated)", opacity: 0.5,
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>
        {error ?? "No planning data found."}
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
          <h2 style={{
            fontSize: "0.95rem", fontWeight: 600, margin: 0,
            color: "var(--text-primary)", fontFamily: "var(--font-body)",
          }}>
            {data.projectName ?? slug}
          </h2>
          {data.status && (
            <span style={{
              fontSize: "0.65rem", fontFamily: "var(--font-body)", fontWeight: 600,
              letterSpacing: "0.05em", textTransform: "uppercase",
              color: "var(--text-muted)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "3px", padding: "2px 6px",
            }}>
              {data.status}
            </span>
          )}
          {data.milestone && (
            <span style={{
              fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)",
            }}>
              {data.milestone}
            </span>
          )}
        </div>
        {data.description && (
          <p style={{
            fontSize: "0.8rem", color: "var(--text-secondary)",
            fontFamily: "var(--font-body)", margin: 0, lineHeight: 1.5,
          }}>
            {data.description}
          </p>
        )}
        <CompletionBar completed={data.completedPhases} total={data.totalPhases} />
      </div>

      {/* Phase list */}
      <div style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}>
        {data.phases.map((phase) => (
          <PhaseRow key={phase.number} phase={phase} />
        ))}
      </div>
    </div>
  );
}
