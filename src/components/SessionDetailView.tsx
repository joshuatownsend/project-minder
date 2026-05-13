"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useSessionDetail } from "@/hooks/useSessions";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCell } from "@/components/ui/StatCell";
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
import { ChartBlock } from "./stats/ChartBlock";
import { EditAcceptanceCard } from "./stats/EditAcceptanceCard";
import { ToolLatencyCard } from "./stats/ToolLatencyCard";
import {
  ArrowLeft,
  GitBranch,
  Zap,
  Terminal,
  Check,
  Star,
  FileDown,
  BookOpen,
} from "lucide-react";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { downloadBlob } from "@/lib/downloadBlob";
import { formatCost, formatDurationMs, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";
import { SourceBadge } from "@/components/SourceBadge";
import { detectRetrySpans } from "@/lib/usage/retryDetector";
import { pluralize } from "@/lib/utils";

const checkboxRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "8px",
  fontSize: "0.8rem", color: "var(--text-primary)", cursor: "pointer",
  padding: "6px 0",
};

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

// ── Star button ───────────────────────────────────────────────────────────────
function StarButton({
  sessionId,
  starredAt,
  onToggle,
}: {
  sessionId: string;
  starredAt: string | undefined;
  onToggle: (newStarredAt: string | undefined) => void;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const isStarred = !!starredAt;

  async function handleToggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/star`, { method: "POST" });
      const d = await res.json();
      if (res.ok) {
        onToggle(d.starredAt as string | undefined);
      } else {
        showToast("Star failed", d.error ?? res.statusText);
      }
    } catch (e: unknown) {
      showToast("Star failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={busy}
      title={isStarred ? "Unstar session" : "Star session"}
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        padding: "5px 11px",
        fontSize: "0.72rem", fontFamily: "var(--font-body)",
        color: isStarred ? "var(--accent)" : "var(--text-muted)",
        background: isStarred ? "var(--accent-bg)" : "var(--bg-surface)",
        border: `1px solid ${isStarred ? "var(--accent-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)", cursor: busy ? "not-allowed" : "pointer",
        opacity: busy ? 0.6 : 1,
        lineHeight: 1, flexShrink: 0,
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
      }}
    >
      <Star style={{ width: "11px", height: "11px", fill: isStarred ? "currentColor" : "none" }} />
      {isStarred ? "Starred" : "Star"}
    </button>
  );
}

// ── Distill button ────────────────────────────────────────────────────────────
function DistillButton({
  sessionId,
  hasDistillation,
  onDistilled,
}: {
  sessionId: string;
  hasDistillation: boolean;
  onDistilled: (text: string, distilledAt: string) => void;
}) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);

  async function handleDistill() {
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/distill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate: hasDistillation }),
      });
      const d = await res.json();
      if (res.ok && d.text) {
        onDistilled(d.text as string, d.distilledAt as string);
      } else {
        showToast("Distillation failed", d.error ?? res.statusText);
      }
    } catch (e: unknown) {
      showToast("Distillation failed", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDistill}
      disabled={loading}
      title={hasDistillation ? "Re-distill session" : "Distill session with LLM"}
      style={{
        ...resumeBtnBase,
        color: "var(--text-muted)",
        borderRadius: "var(--radius)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      <BookOpen style={{ width: "11px", height: "11px" }} />
      {loading ? "Distilling…" : hasDistillation ? "Re-distill" : "Distill"}
    </button>
  );
}

// ── Export modal ──────────────────────────────────────────────────────────────
type ExportSection = "timeline" | "files" | "subagents";

function ExportModal({
  open,
  onClose,
  data,
  generatedTitle,
}: {
  open: boolean;
  onClose: () => void;
  data: import("@/lib/types").SessionDetail;
  generatedTitle: string | undefined;
}) {
  const { currency, fxRate } = useCurrency();
  const [sections, setSections] = useState<Set<ExportSection>>(
    new Set(["timeline", "files", "subagents"])
  );
  const [turnLimit, setTurnLimit] = useState<string>("");

  function toggleSection(s: ExportSection) {
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  function buildMarkdown(): string {
    const title = generatedTitle ?? data.sessionId.slice(0, 16);
    const date = data.startTime ? new Date(data.startTime).toLocaleString() : "Unknown date";
    const lines: string[] = [
      `# Session: ${title}`,
      "",
      `**Project:** ${data.projectName}`,
      `**Date:** ${date}`,
      data.gitBranch ? `**Branch:** ${data.gitBranch}` : "",
      `**Duration:** ${data.durationMs ? formatDurationMs(data.durationMs) : "—"}`,
      `**Cost:** ${formatCost(data.costEstimate, currency, fxRate)}`,
      `**Session ID:** \`${data.sessionId}\``,
      "",
    ].filter(Boolean);

    if (sections.has("timeline")) {
      const limit = parseInt(turnLimit, 10);
      const events = isNaN(limit) || limit <= 0 ? data.timeline : data.timeline.slice(0, limit);
      lines.push("---", "", "## Conversation", "");
      const roleLabels: Record<string, string> = { user: "User", assistant: "Assistant", error: "Error", thinking: "Thinking" };
      for (const ev of events) {
        const role = ev.type === "tool_use" ? `Tool: ${ev.toolName ?? "unknown"}` : (roleLabels[ev.type] ?? ev.type);
        const ts = ev.timestamp ? ` _(${new Date(ev.timestamp).toLocaleTimeString()})_` : "";
        lines.push(`### ${role}${ts}`, "", ev.content, "");
      }
    }

    if (sections.has("files") && data.fileOperations.length > 0) {
      lines.push("---", "", "## File Operations", "");
      for (const op of data.fileOperations) {
        lines.push(`- **${op.operation}**: \`${op.path}\``);
      }
      lines.push("");
    }

    if (sections.has("subagents") && data.subagents.length > 0) {
      lines.push("---", "", "## Subagents", "");
      for (const sub of data.subagents) {
        lines.push(`- **${sub.type}** — ${sub.description ?? "—"}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  function handleDownload() {
    downloadBlob(buildMarkdown(), `session-${data.sessionId.slice(0, 8)}.md`, "text/markdown;charset=utf-8");
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Export session as Markdown" maxWidthClass="max-w-sm">
      <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Sections to include</div>
          {(["timeline", "files", "subagents"] as ExportSection[]).map((s) => (
            <label key={s} style={checkboxRowStyle}>
              <input
                type="checkbox"
                checked={sections.has(s)}
                onChange={() => toggleSection(s)}
                style={{ width: "14px", height: "14px", accentColor: "var(--accent)" }}
              />
              {s === "timeline" ? "Conversation timeline" : s === "files" ? "File operations" : "Subagents"}
            </label>
          ))}
        </div>
        {sections.has("timeline") && (
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "6px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Turn limit</div>
            <input
              type="number"
              min={1}
              value={turnLimit}
              onChange={(e) => setTurnLimit(e.target.value)}
              placeholder={`All (${data.timeline.length} events)`}
              style={{
                width: "100%", boxSizing: "border-box", padding: "6px 10px",
                borderRadius: "var(--radius)", border: "1px solid var(--border-default)",
                background: "var(--surface-2, transparent)", color: "var(--text-primary)",
                fontSize: "0.82rem", fontFamily: "var(--font-body)",
              }}
            />
          </div>
        )}
        <button
          onClick={handleDownload}
          disabled={sections.size === 0}
          style={{
            padding: "8px 16px", fontSize: "0.8rem", fontWeight: 600,
            background: sections.size === 0 ? "var(--surface-2)" : "var(--accent)",
            color: sections.size === 0 ? "var(--text-muted)" : "#fff",
            border: "none", borderRadius: "var(--radius)", cursor: sections.size === 0 ? "not-allowed" : "pointer",
          }}
        >
          Download .md
        </button>
      </div>
    </Modal>
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
        ...resumeBtnBase,
        color: "var(--text-muted)",
        borderRadius: "var(--radius)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      <Zap style={{ width: "11px", height: "11px" }} />
      {loading ? "Generating…" : hasTitle ? "Regenerate" : "Generate title"}
    </button>
  );
}

// Stats-strip cell now uses the shared primitive — see src/components/ui/StatCell.tsx.

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
  const { currency, fxRate } = useCurrency();
  const [activeTab, setActiveTab] = useState<TabKey>("timeline");
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [generatedTitle, setGeneratedTitle] = useState<string | undefined>(undefined);
  const [starredAt, setStarredAt] = useState<string | undefined>(undefined);
  const [distilledText, setDistilledText] = useState<string | undefined>(undefined);
  const [distilledAt, setDistilledAt] = useState<string | undefined>(undefined);
  const [replayIndex, setReplayIndex] = useState<number | undefined>(undefined);
  useEffect(() => { setReplayIndex(undefined); }, [sessionId]);
  useDocumentTitle(data ? (data.projectPath?.split(/[\\/]/).pop() ?? "Session") : "Session");

  const retrySpans = useMemo(
    () => (data ? detectRetrySpans(data.timeline) : []),
    [data]
  );

  useEffect(() => {
    setGeneratedTitle(data?.generatedTitle);
    setStarredAt(data?.starredAt);
    setDistilledText(data?.distilledText);
    setDistilledAt(data?.distilledAt);
  }, [data?.generatedTitle, data?.starredAt, data?.distilledText, data?.distilledAt]);

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
    { label: "Duration",   value: formatDurationMs(data.durationMs) },
    { label: "Messages",   value: data.messageCount,  detail: `${data.userMessageCount}u · ${data.assistantMessageCount}a` },
    { label: "Tokens",     value: formatTokens(data.inputTokens + data.outputTokens), detail: `${formatTokens(data.inputTokens)} in · ${formatTokens(data.outputTokens)} out` },
    { label: "Cost",       value: formatCost(data.costEstimate, currency, fxRate) },
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
        <StarButton
          sessionId={sessionId}
          starredAt={starredAt}
          onToggle={setStarredAt}
        />
        <DistillButton
          sessionId={sessionId}
          hasDistillation={!!distilledText}
          onDistilled={(text, at) => { setDistilledText(text); setDistilledAt(at); }}
        />
        <GenerateTitleButton
          sessionId={sessionId}
          hasTitle={!!generatedTitle}
          onTitleGenerated={handleTitleGenerated}
        />
        <button
          onClick={() => setExportModalOpen(true)}
          title="Export session as Markdown"
          style={{ ...resumeBtnBase, color: "var(--text-muted)", borderRadius: "var(--radius)", cursor: "pointer" }}
        >
          <FileDown style={{ width: "11px", height: "11px" }} />
          Export
        </button>
        <ResumeButton sessionId={sessionId} />
      </div>
      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        data={data}
        generatedTitle={generatedTitle}
      />

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
          <SourceBadge source={data.source} />
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

      {/* ── Distillation panel ──────────────────────────────────────────────── */}
      {distilledText && (
        <div style={{
          padding: "16px 20px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderTop: "none",
          display: "flex", flexDirection: "column", gap: "8px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <BookOpen style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Distillation
            </span>
            {distilledAt && (
              <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                {new Date(distilledAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <pre style={{
            fontSize: "0.76rem", color: "var(--text-secondary)", lineHeight: 1.65,
            fontFamily: "var(--font-body)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {distilledText}
          </pre>
        </div>
      )}

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
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {data.timeline.length > 1 && (
                <div style={{
                  display: "flex", alignItems: "center", gap: "8px",
                  padding: "6px 8px",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius)",
                  fontSize: "0.68rem", color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}>
                  <span style={{ flexShrink: 0 }}>Replay</span>
                  <input
                    type="range"
                    min={0}
                    max={data.timeline.length - 1}
                    value={replayIndex ?? data.timeline.length - 1}
                    onChange={(e) => setReplayIndex(parseInt(e.target.value, 10))}
                    aria-label="Replay scrubber"
                    style={{ flex: 1, accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  <span style={{ flexShrink: 0, minWidth: "6ch", textAlign: "right" }}>
                    {replayIndex !== undefined
                      ? `${replayIndex + 1} / ${data.timeline.length}`
                      : `${data.timeline.length}`}
                  </span>
                  {replayIndex !== undefined && (
                    <button
                      onClick={() => setReplayIndex(undefined)}
                      style={{
                        flexShrink: 0, padding: "2px 7px",
                        fontSize: "0.65rem", fontFamily: "var(--font-body)",
                        background: "var(--bg-surface)", border: "1px solid var(--border-default)",
                        borderRadius: "3px", cursor: "pointer", color: "var(--text-muted)",
                      }}
                    >
                      Reset
                    </button>
                  )}
                  {retrySpans.length > 0 && (
                    <span
                      style={{
                        flexShrink: 0, padding: "1px 6px",
                        fontSize: "0.62rem",
                        background: "var(--amber-bg,#451a03)",
                        color: "var(--amber-text,#fbbf24)",
                        border: "1px solid var(--amber-border,#92400e)",
                        borderRadius: "3px",
                      }}
                      title="Edit-test-reEdit retry cycles detected and highlighted with an amber border"
                    >
                      {pluralize(retrySpans.length, "retry cycle")}
                    </span>
                  )}
                </div>
              )}
              <div style={{
                maxHeight: "calc(100vh - 480px)",
                minHeight: "300px",
                overflowY: "auto",
              }}>
                <SessionTimeline
                  timeline={data.timeline}
                  sessionStart={data.startTime}
                  sessionId={data.sessionId}
                  cutoffIndex={replayIndex}
                  retrySpans={retrySpans}
                />
              </div>
            </div>
          )}

          {activeTab === "tools" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <ChartBlock title="Edit Acceptance">
                  <EditAcceptanceCard
                    sessionId={data.sessionId}
                    since={data.startTime ? new Date(new Date(data.startTime).getTime() - 5 * 60 * 1000).toISOString() : undefined}
                  />
                </ChartBlock>
                <ChartBlock title="Tool Latency">
                  <ToolLatencyCard
                    sessionId={data.sessionId}
                    since={data.startTime ? new Date(new Date(data.startTime).getTime() - 5 * 60 * 1000).toISOString() : undefined}
                  />
                </ChartBlock>
              </div>
              <BarChart data={data.toolUsage} color="var(--accent)" maxItems={20} />
            </div>
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
