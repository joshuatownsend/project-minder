"use client";

import { formatCostCompact, formatDurationSeconds } from "@/lib/format";
import type { LiveAgentSession, AgentSessionStatus } from "@/lib/agentView/types";

const STATUS_COLORS: Record<AgentSessionStatus, { bg: string; text: string; border: string; label: string }> = {
  waiting:   { bg: "var(--amber-bg,#451a03)",   text: "var(--amber-text,#fbbf24)", border: "var(--amber-border,#92400e)", label: "Needs Input" },
  working:   { bg: "var(--blue-bg,#0c1a2e)",    text: "var(--blue-text,#60a5fa)",  border: "var(--blue-border,#1e3a5f)",  label: "Working" },
  idle:      { bg: "var(--card-bg,#111)",        text: "var(--text-3,#888)",        border: "var(--line-soft,#222)",       label: "Idle" },
  completed: { bg: "var(--green-bg,#052e16)",   text: "var(--green-text,#4ade80)", border: "var(--green-border,#14532d)", label: "Completed" },
  failed:    { bg: "var(--red-bg,#2d0a0a)",     text: "var(--red-text,#f87171)",   border: "var(--red-border,#7f1d1d)",   label: "Failed" },
  stopped:   { bg: "var(--card-bg,#111)",        text: "var(--text-4,#555)",        border: "var(--line-soft,#222)",       label: "Stopped" },
};


interface AgentCardProps {
  session: LiveAgentSession;
  onPeek: (session: LiveAgentSession) => void;
}

export function AgentCard({ session, onPeek }: AgentCardProps) {
  const sc = STATUS_COLORS[session.status];
  const cost = session.costEstimate != null && session.costEstimate > 0
    ? formatCostCompact(session.costEstimate)
    : null;
  const ctxPct = session.maxContextFill != null
    ? Math.round(session.maxContextFill * 100)
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPeek(session)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPeek(session); } }}
      style={{
        background: sc.bg,
        border: `1px solid ${sc.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        outline: "none",
        transition: "filter 0.1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.15)")}
      onMouseLeave={(e) => (e.currentTarget.style.filter = "")}
    >
      {/* Header row: process dot + project name + model badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Process running indicator: filled = daemon-confirmed, ring = inferred */}
        <span
          title={session.runningProcess ? "Process running (confirmed)" : "Process inferred from JSONL"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: session.runningProcess ? sc.text : "transparent",
            border: `1.5px solid ${sc.text}`,
            flexShrink: 0,
          }}
        />
        <span style={{
          fontSize: "0.7rem",
          fontWeight: 600,
          color: sc.text,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}>
          {session.projectName}
        </span>
        {session.worktreeLabel && (
          <span style={{
            fontSize: "0.6rem",
            color: "var(--text-4,#555)",
            background: "var(--card-bg-2,#1a1a1a)",
            border: "1px solid var(--line-soft,#222)",
            borderRadius: 3,
            padding: "1px 4px",
            flexShrink: 0,
          }}>
            {session.worktreeLabel}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {session.model && (
          <span style={{
            fontSize: "0.55rem",
            color: "var(--text-4,#555)",
            fontFamily: "var(--font-mono,monospace)",
            flexShrink: 0,
          }}>
            {session.model.replace("claude-", "").replace(/-\d{8}$/, "")}
          </span>
        )}
      </div>

      {/* Activity line */}
      {session.currentActivityLine && (
        <div style={{
          fontSize: "0.7rem",
          color: "var(--text-2,#ccc)",
          fontFamily: "var(--font-mono,monospace)",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}>
          {session.currentActivityLine}
        </div>
      )}

      {/* Footer: age + chips */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: "0.6rem", color: "var(--text-4,#555)" }}>
          {formatDurationSeconds(session.secondsSinceChange)} ago
        </span>
        <div style={{ flex: 1 }} />
        {ctxPct != null && ctxPct > 50 && (
          <span style={{
            fontSize: "0.55rem",
            padding: "1px 5px",
            borderRadius: 3,
            background: ctxPct > 85 ? "var(--red-bg,#2d0a0a)" : "var(--amber-bg,#451a03)",
            color: ctxPct > 85 ? "var(--red-text,#f87171)" : "var(--amber-text,#fbbf24)",
            border: `1px solid ${ctxPct > 85 ? "var(--red-border,#7f1d1d)" : "var(--amber-border,#92400e)"}`,
          }}>
            {ctxPct}% ctx
          </span>
        )}
        {cost && (
          <span style={{
            fontSize: "0.55rem",
            padding: "1px 5px",
            borderRadius: 3,
            background: "var(--card-bg-2,#1a1a1a)",
            color: "var(--text-3,#888)",
            border: "1px solid var(--line-soft,#222)",
          }}>
            {cost}
          </span>
        )}
        {session.subagentsInFlight != null && session.subagentsInFlight > 0 && (
          <span
            title={`${session.subagentsInFlight} sub-agent${session.subagentsInFlight === 1 ? "" : "s"} in flight`}
            style={{
              fontSize: "0.55rem",
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--blue-bg,#0c1a2e)",
              color: "var(--blue-text,#60a5fa)",
              border: "1px solid var(--blue-border,#1e3a5f)",
            }}
          >
            +{session.subagentsInFlight}
          </span>
        )}
      </div>
    </div>
  );
}
