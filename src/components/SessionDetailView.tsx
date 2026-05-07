"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { useSessionDetail } from "@/hooks/useSessions";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ToastProvider";

const OrchestrationDAG = dynamic(
  () => import("./viz/OrchestrationDAG").then((m) => m.OrchestrationDAG),
  { ssr: false, loading: () => <Skeleton className="h-96" /> }
);
const ConcurrencyTimeline = dynamic(
  () => import("./viz/ConcurrencyTimeline").then((m) => m.ConcurrencyTimeline),
  { ssr: false, loading: () => <Skeleton className="h-48" /> }
);
const ModelDelegationFlow = dynamic(
  () => import("./viz/ModelDelegationFlow").then((m) => m.ModelDelegationFlow),
  { ssr: false, loading: () => <Skeleton className="h-80" /> }
);
const AgentNetworkGraph = dynamic(
  () => import("./viz/AgentNetworkGraph").then((m) => m.AgentNetworkGraph),
  { ssr: false, loading: () => <Skeleton className="h-96" /> }
);
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { SessionTimeline } from "./SessionTimeline";
import { SessionFileOps } from "./SessionFileOps";
import { SessionSubagents } from "./SessionSubagents";
import { DiagnosisPanel } from "./DiagnosisPanel";
import { HandoffPanel } from "./HandoffPanel";
import { HandoffDocModal } from "./HandoffDocModal";
import { FeedbackPanel } from "./FeedbackPanel";
import { BarChart } from "./stats/BarChart";
import {
  ArrowLeft,
  GitBranch,
  Zap,
  Terminal,
  Check,
} from "lucide-react";
import Link from "next/link";

const resumeBtnBase: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "5px",
  padding: "5px 11px",
  fontSize: "0.72rem", fontFamily: "var(--font-body)", letterSpacing: "0.03em",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  cursor: "pointer",
  transition: "color 0.15s, background 0.15s",
  lineHeight: 1, flexShrink: 0,
};

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

// ── Resume / terminal split button ───────────────────────────────────────────
function ResumeButton({ sessionId }: { sessionId: string }) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const copyCommand = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(`claude --resume ${sessionId}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };

  const openInTerminal = async () => {
    setLaunching(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/resume-terminal`, { method: "POST" });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        const fallback: string = d.fallback ?? `claude --resume ${sessionId}`;
        showToast("Terminal launch failed", `Run manually: ${fallback}`);
      }
    } catch {
      showToast("Terminal launch failed", "Check terminal settings.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      {/* Primary: open in terminal */}
      <button
        onClick={openInTerminal}
        disabled={launching}
        title={`Open in terminal: claude --resume ${sessionId}`}
        style={{
          ...resumeBtnBase,
          color: "var(--text-secondary)",
          borderRadius: "var(--radius) 0 0 var(--radius)",
          borderRight: "none",
          opacity: launching ? 0.6 : 1,
        }}
      >
        <Terminal style={{ width: "11px", height: "11px" }} />
        {launching ? "Opening…" : "Resume"}
      </button>
      {/* Dropdown chevron */}
      <button
        onClick={() => setDropdownOpen((v) => !v)}
        title="More options"
        style={{
          ...resumeBtnBase,
          padding: "5px 7px",
          color: "var(--text-muted)",
          borderRadius: "0 var(--radius) var(--radius) 0",
        }}
      >
        <span style={{ fontSize: "0.6rem" }}>▾</span>
      </button>
      {dropdownOpen && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0,
            background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)", padding: "4px",
            zIndex: 50, minWidth: "160px", boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
          onMouseLeave={() => setDropdownOpen(false)}
        >
          <button
            onClick={() => { copyCommand(); setDropdownOpen(false); }}
            style={{
              display: "flex", alignItems: "center", gap: "6px",
              width: "100%", padding: "6px 10px",
              fontSize: "0.72rem", fontFamily: "var(--font-body)",
              color: copied ? "var(--status-active-text)" : "var(--text-secondary)",
              background: "transparent", border: "none", borderRadius: "3px",
              cursor: "pointer", textAlign: "left",
            }}
          >
            {copied
              ? <><Check style={{ width: "11px", height: "11px" }} /> Copied!</>
              : <><Check style={{ width: "11px", height: "11px", opacity: 0 }} /> Copy command</>}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Generate title button ─────────────────────────────────────────────────────
function GenerateTitleButton({
  sessionId,
  hasTitle,
  onTitleGenerated,
}: {
  sessionId: string;
  hasTitle: boolean;
  onTitleGenerated: (title: string) => void;
}) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate: hasTitle }),
      });
      const d = await res.json();
      if (res.ok && d.title) {
        onTitleGenerated(d.title as string);
      } else {
        showToast("Title generation failed", d.error ?? res.statusText);
      }
    } catch (e: unknown) {
      showToast("Title generation failed", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleGenerate}
      disabled={loading}
      title={hasTitle ? "Regenerate title" : "Generate title with LLM"}
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        padding: "5px 11px",
        fontSize: "0.72rem", fontFamily: "var(--font-body)",
        color: "var(--text-muted)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)", cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
        lineHeight: 1, flexShrink: 0,
      }}
    >
      <Zap style={{ width: "11px", height: "11px" }} />
      {loading ? "Generating…" : hasTitle ? "Regenerate" : "Generate title"}
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
type TabKey = "timeline" | "tools" | "files" | "skills" | "subagents" | "orchestration" | "concurrency" | "delegation" | "network" | "handoff" | "diagnosis" | "feedback";

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
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [generatedTitle, setGeneratedTitle] = useState<string | undefined>(undefined);
  useDocumentTitle(data ? (data.projectPath?.split(/[\\/]/).pop() ?? "Session") : "Session");

  useEffect(() => {
    if (data?.generatedTitle) setGeneratedTitle(data.generatedTitle);
  }, [data?.generatedTitle]);

  const handleTitleGenerated = useCallback((title: string) => setGeneratedTitle(title), []);

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
    ...(data.subagentCount > 0
      ? [{ key: "orchestration" as TabKey, label: "Orchestration" }]
      : []),
    ...(data.subagents.length > 0
      ? ([
          { key: "concurrency", label: "Concurrency" },
          { key: "delegation",  label: "Delegation"  },
          { key: "network",     label: "Network"     },
        ] as { key: TabKey; label: string }[])
      : []),
    { key: "handoff",   label: "Handoff"   },
    { key: "diagnosis", label: "Diagnosis" },
    { key: "feedback",  label: "Feedback"  },
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
        <GenerateTitleButton
          sessionId={sessionId}
          hasTitle={!!generatedTitle}
          onTitleGenerated={handleTitleGenerated}
        />
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

        {/* Generated title — shown as a subtitle when present */}
        {generatedTitle && (
          <p style={{
            fontSize: "0.82rem", color: "var(--accent)",
            margin: 0, lineHeight: 1.4,
            fontFamily: "var(--font-body)", fontWeight: 500,
          }}>
            {generatedTitle}
          </p>
        )}

        {/* Initial prompt — shown only when there's no recap (recap takes priority in the header) */}
        {data.initialPrompt && !data.recaps?.length && (
          <p style={{
            fontSize: "0.85rem", color: "var(--text-secondary)",
            lineHeight: 1.55, margin: 0,
            fontStyle: "italic",
            background: "var(--bg-elevated)",
            borderRadius: "var(--radius)",
            padding: "8px 12px",
          }}>
            {data.initialPrompt}
          </p>
        )}

        {/* Recap history — latest shown prominently, older ones collapsed below */}
        {data.recaps && data.recaps.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {/* Latest recap — primary summary */}
            <div style={{
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-border)",
              borderRadius: "var(--radius)",
              padding: "10px 14px",
              display: "flex", flexDirection: "column", gap: "4px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{
                  fontSize: "0.6rem", fontFamily: "var(--font-mono)",
                  fontWeight: 600, letterSpacing: "0.06em",
                  color: "var(--accent)", textTransform: "uppercase",
                }}>
                  recap
                </span>
                <span style={{ fontSize: "0.62rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {new Date(data.recaps[data.recaps.length - 1].timestamp).toLocaleString()}
                </span>
                {data.recaps.length > 1 && (
                  <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                    {data.recaps.length} total
                  </span>
                )}
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
                {data.recaps[data.recaps.length - 1].content}
              </p>
            </div>
            {/* Earlier recaps — show when more than one exists */}
            {data.recaps.length > 1 && data.recaps.slice(0, -1).reverse().map((recap, i) => (
              <div key={i} style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: "8px 14px",
                display: "flex", flexDirection: "column", gap: "3px",
                opacity: 0.75,
              }}>
                <span style={{ fontSize: "0.6rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {new Date(recap.timestamp).toLocaleString()}
                </span>
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.5, margin: 0 }}>
                  {recap.content}
                </p>
              </div>
            ))}
          </div>
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
              <SessionTimeline timeline={data.timeline} sessionStart={data.startTime} sessionId={data.sessionId} />
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

          {activeTab === "orchestration" && (
            <OrchestrationDAG sessionId={data.sessionId} />
          )}

          {activeTab === "concurrency" && (
            <ConcurrencyTimeline sessionId={data.sessionId} />
          )}

          {activeTab === "delegation" && (
            <ModelDelegationFlow sessionId={data.sessionId} />
          )}

          {activeTab === "network" && (
            <AgentNetworkGraph sessionId={data.sessionId} />
          )}

          {activeTab === "handoff" && (
            <HandoffPanel
              sessionId={data.sessionId}
              onOpenDocModal={() => setDocModalOpen(true)}
            />
          )}

          {activeTab === "diagnosis" && (
            <DiagnosisPanel sessionId={data.sessionId} />
          )}

          {activeTab === "feedback" && (
            <FeedbackPanel sessionId={data.sessionId} />
          )}
        </div>
      </div>

      <HandoffDocModal
        sessionId={data.sessionId}
        open={docModalOpen}
        onClose={() => setDocModalOpen(false)}
      />
    </div>
  );
}
