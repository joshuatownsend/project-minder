"use client";

import { useState } from "react";
import { useSessionDetail } from "@/hooks/useSessions";
import { SessionTimeline } from "./SessionTimeline";
import { SessionFileOps } from "./SessionFileOps";
import { SessionSubagents } from "./SessionSubagents";
import { BarChart } from "./stats/BarChart";
import {
  ArrowLeft,
  GitBranch,
  Zap,
  Terminal,
  Check,
} from "lucide-react";
import Link from "next/link";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

// ── Resume button ─────────────────────────────────────────────────────────────
function ResumeButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(`claude --resume ${sessionId}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : `Copy: claude --resume ${sessionId}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        padding: "5px 11px",
        fontSize: "0.72rem", fontFamily: "var(--font-body)", letterSpacing: "0.03em",
        color: copied ? "var(--status-active-text)" : "var(--text-secondary)",
        background: copied ? "var(--status-active-bg)" : "var(--bg-surface)",
        border: `1px solid ${copied ? "var(--status-active-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)", cursor: "pointer",
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
        lineHeight: 1, flexShrink: 0,
      }}
    >
      {copied
        ? <><Check style={{ width: "11px", height: "11px" }} /> Copied</>
        : <><Terminal style={{ width: "11px", height: "11px" }} /> Resume</>}
    </button>
  );
}

// ── Stats strip ───────────────────────────────────────────────────────────────
function StatCell({
  label, value, detail, accent, last,
}: {
  label: string; value: string | number; detail?: string;
  accent?: "error" | "warn"; last?: boolean;
}) {
  const valueColor =
    accent === "error" ? "var(--status-error-text)" :
    accent === "warn"  ? "var(--accent)" :
    "var(--text-primary)";

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: "3px",
        padding: "14px 20px",
        borderRight: last ? "none" : "1px solid var(--border-subtle)",
        minWidth: "90px", flex: "1 1 90px",
      }}
    >
      <span style={{
        fontSize: "0.6rem", fontWeight: 600, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "1.25rem", fontWeight: 600,
        color: valueColor, lineHeight: 1.1,
      }}>
        {value}
      </span>
      {detail && (
        <span style={{
          fontSize: "0.62rem", color: "var(--text-muted)",
          fontFamily: "var(--font-mono)", lineHeight: 1.4,
        }}>
          {detail}
        </span>
      )}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
type TabKey = "timeline" | "tools" | "files" | "skills" | "subagents";

function TabBar({
  tabs, active, onChange,
}: {
  tabs: { key: TabKey; label: string }[];
  active: TabKey;
  onChange: (k: TabKey) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      borderBottom: "1px solid var(--border-subtle)",
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            padding: "9px 16px",
            fontSize: "0.72rem", fontFamily: "var(--font-body)",
            letterSpacing: "0.03em",
            fontWeight: active === tab.key ? 600 : 400,
            color: active === tab.key ? "var(--text-primary)" : "var(--text-secondary)",
            background: "transparent", border: "none",
            borderBottom: active === tab.key
              ? "2px solid var(--accent)"
              : "2px solid transparent",
            cursor: "pointer",
            transition: "color 0.1s",
            lineHeight: 1, marginBottom: "-1px",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const { data, loading } = useSessionDetail(sessionId);
  const [activeTab, setActiveTab] = useState<TabKey>("timeline");

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {[20, 100, 72, 500].map((h, i) => (
          <div key={i} style={{ height: `${h}px`, background: "var(--bg-surface)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <Link href="/sessions" style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.72rem", color: "var(--text-secondary)", textDecoration: "none" }}>
          <ArrowLeft style={{ width: "12px", height: "12px" }} /> Sessions
        </Link>
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "48px 0" }}>
          Session not found.
        </p>
      </div>
    );
  }

  const totalTools = Object.values(data.toolUsage).reduce((s, c) => s + c, 0);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "timeline",  label: `Timeline (${data.timeline.length})` },
    { key: "tools",     label: `Tools (${Object.keys(data.toolUsage).length})` },
    { key: "files",     label: `Files (${data.fileOperations.length})` },
    ...(Object.keys(data.skillsUsed).length > 0
      ? [{ key: "skills" as TabKey, label: `Skills (${Object.keys(data.skillsUsed).length})` }]
      : []),
    ...(data.subagents.length > 0
      ? [{ key: "subagents" as TabKey, label: `Subagents (${data.subagents.length})` }]
      : []),
  ];

  const statCells = [
    { label: "Duration",   value: formatDuration(data.durationMs) },
    { label: "Messages",   value: data.messageCount,  detail: `${data.userMessageCount}u · ${data.assistantMessageCount}a` },
    { label: "Tokens",     value: formatTokens(data.inputTokens + data.outputTokens), detail: `${formatTokens(data.inputTokens)} in · ${formatTokens(data.outputTokens)} out` },
    { label: "Cost",       value: formatCost(data.costEstimate) },
    { label: "Tools",      value: totalTools,          detail: `${Object.keys(data.toolUsage).length} unique` },
    ...(data.errorCount > 0    ? [{ label: "Errors",    value: data.errorCount,    accent: "error" as const }] : []),
    ...(data.subagentCount > 0 ? [{ label: "Subagents", value: data.subagentCount }] : []),
    ...(data.oneShotRate !== undefined ? [{
      label: "1-shot rate",
      value: `${(data.oneShotRate * 100).toFixed(0)}%`,
      accent: (data.oneShotRate >= 0.8 ? undefined : data.oneShotRate >= 0.5 ? "warn" : "error") as "warn" | "error" | undefined,
    }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>

      {/* ── Nav row ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", paddingBottom: "20px" }}>
        <Link
          href="/sessions"
          style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.72rem", color: "var(--text-secondary)", textDecoration: "none" }}
        >
          <ArrowLeft style={{ width: "12px", height: "12px" }} />
          Sessions
        </Link>
        <span style={{ fontSize: "0.72rem", color: "var(--border-default)" }}>/</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
          {data.sessionId.slice(0, 16)}…
        </span>
        <div style={{ flex: 1 }} />
        <ResumeButton sessionId={sessionId} />
      </div>

      {/* ── Header block ────────────────────────────────────────────────────── */}
      <div style={{
        padding: "20px 24px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius) var(--radius) 0 0",
        borderBottom: "none",
        display: "flex", flexDirection: "column", gap: "10px",
      }}>
        {/* Project name + metadata chips */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {data.isActive && (
            <span style={{ position: "relative", display: "inline-flex", width: "8px", height: "8px", flexShrink: 0 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--status-active-text)", opacity: 0.5, animation: "ping 1s cubic-bezier(0,0,0.2,1) infinite" }} />
              <span style={{ position: "relative", width: "8px", height: "8px", borderRadius: "50%", background: "var(--status-active-text)" }} />
            </span>
          )}
          <h1 style={{
            fontSize: "1.1rem", fontWeight: 700,
            color: "var(--text-primary)", fontFamily: "var(--font-body)",
            letterSpacing: "-0.01em",
          }}>
            {data.projectName}
          </h1>
          {data.gitBranch && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)", background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "2px 7px" }}>
              <GitBranch style={{ width: "10px", height: "10px" }} />
              {data.gitBranch}
            </span>
          )}
          {data.modelsUsed.map((m) => (
            <span key={m} style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)", background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "2px 6px" }}>
              {m}
            </span>
          ))}
        </div>

        {/* Initial prompt */}
        {data.initialPrompt && (
          <p style={{
            fontSize: "0.85rem", color: "var(--text-secondary)",
            lineHeight: 1.55, margin: 0,
            fontStyle: "italic",
            paddingLeft: "12px",
            borderLeft: "2px solid var(--border-default)",
          }}>
            {data.initialPrompt}
          </p>
        )}

        {/* Timestamp line */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
            {data.startTime ? new Date(data.startTime).toLocaleString() : "—"}
            {data.endTime ? ` — ${new Date(data.endTime).toLocaleTimeString()}` : ""}
          </span>
        </div>
      </div>

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderTop: "1px solid var(--border-default)",
        borderRadius: "0",
      }}>
        {statCells.map((cell, i) => (
          <StatCell
            key={cell.label}
            label={cell.label}
            value={cell.value}
            detail={cell.detail}
            accent={cell.accent}
            last={i === statCells.length - 1}
          />
        ))}
      </div>

      {/* ── Tab section ─────────────────────────────────────────────────────── */}
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderTop: "1px solid var(--border-default)",
        borderRadius: "0 0 var(--radius) var(--radius)",
        marginTop: "0",
        overflow: "hidden",
      }}>
        <div style={{ padding: "0 4px" }}>
          <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />
        </div>

        <div style={{ padding: "16px 20px" }}>
          {activeTab === "timeline" && (
            <div style={{
              maxHeight: "calc(100vh - 420px)",
              minHeight: "300px",
              overflowY: "auto",
            }}>
              <SessionTimeline timeline={data.timeline} sessionStart={data.startTime} />
            </div>
          )}

          {activeTab === "tools" && (
            <BarChart data={data.toolUsage} color="var(--accent)" maxItems={20} />
          )}

          {activeTab === "files" && (
            <SessionFileOps operations={data.fileOperations} />
          )}

          {activeTab === "skills" && Object.keys(data.skillsUsed).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {Object.entries(data.skillsUsed)
                .sort((a, b) => b[1] - a[1])
                .map(([skill, count]) => (
                  <div
                    key={skill}
                    style={{ display: "flex", alignItems: "center", gap: "8px", padding: "7px 8px", borderRadius: "3px" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <Zap style={{ width: "12px", height: "12px", color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text-primary)", flex: 1 }}>{skill}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>{count}×</span>
                  </div>
                ))}
            </div>
          )}

          {activeTab === "subagents" && (
            <SessionSubagents subagents={data.subagents} />
          )}
        </div>
      </div>
    </div>
  );
}
