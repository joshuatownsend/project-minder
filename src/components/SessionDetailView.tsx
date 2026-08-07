"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useSessionDetail } from "@/hooks/useSessions";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
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
import { SessionHooksPanel } from "./SessionHooksPanel";
import { DiagnosisPanel } from "./DiagnosisPanel";
import { ContextAttributionPanel } from "./ContextAttributionPanel";
import { SessionMetaPanel } from "./SessionMetaPanel";
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
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import type { SessionPermissionMode } from "@/lib/types/session";
import { Modal } from "@/components/ui/modal";
import { downloadBlob } from "@/lib/downloadBlob";
import { formatCost, formatDurationMs, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";
import { SourceBadge } from "@/components/SourceBadge";
import { detectRetrySpans } from "@/lib/usage/retryDetector";
import { pluralize } from "@/lib/utils";
import { compareEffort } from "@/lib/usage/effort";

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
//
// The document is rendered server-side by `GET /api/sessions/<id>/export`,
// not from `data.timeline`. The timeline is a preview: assistant text is
// capped at 300 chars on the file path and 500 on the DB path, and thinking
// is stored out-of-line entirely. Only the session's own JSONL holds the
// transcript, so the export has to be read there — see
// `src/lib/sessions/exportReader.ts`.
type ExportDetailLevel = "minimal" | "standard" | "full";

const DETAIL_BLURB: Record<ExportDetailLevel, string> = {
  minimal: "Prompts and replies only — no tool calls.",
  standard: "Prompts, replies, tool calls, and truncated tool results.",
  full: "Everything, including extended thinking and subagent messages.",
};

interface ExportStats {
  messages: number;
  sidechainsSkipped: number;
  blocks: number;
  blocksOmitted: number;
  blocksTruncated: number;
  charsTruncated: number;
  bytes: number;
}

function ExportModal({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: import("@/lib/types").SessionDetail;
}) {
  const { showToast } = useToast();
  const [level, setLevel] = useState<ExportDetailLevel>("standard");
  const [thinking, setThinking] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // `null` means "inherit the level's default", which is what the API's
  // absent-param behaviour already does — so an untouched checkbox sends
  // nothing and the preset stays authoritative.
  const thinkingChecked = thinking ?? level === "full";

  function buildUrl(format: "md" | "json"): string {
    const params = new URLSearchParams({ detail: level, format });
    if (thinking !== null) params.set("thinking", thinking ? "1" : "0");
    return `/api/sessions/${data.sessionId}/export?${params.toString()}`;
  }

  async function fetchExport(): Promise<{ markdown: string; stats: ExportStats; fidelity: string } | null> {
    const res = await fetch(buildUrl("json"));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast("Export failed", body?.error ?? `HTTP ${res.status}`);
      return null;
    }
    return res.json();
  }

  /** Report what the export actually contains, including what it left out. */
  function reportOutcome(stats: ExportStats, fidelity: string, verb: string): void {
    const size = stats.bytes > 1024 ? `${Math.round(stats.bytes / 1024)} KB` : `${stats.bytes} B`;
    const notes = [`${stats.messages} messages`, size];
    if (stats.blocksTruncated > 0) notes.push(`${stats.blocksTruncated} truncated`);
    showToast(
      fidelity === "index" ? `${verb} — reduced fidelity` : verb,
      fidelity === "index"
        ? `${notes.join(" · ")}. Transcript file unavailable; text came from the index.`
        : notes.join(" · ")
    );
  }

  async function handleDownload() {
    setBusy(true);
    try {
      const result = await fetchExport();
      if (!result) return;
      downloadBlob(
        result.markdown,
        `session-${data.sessionId.slice(0, 8)}.md`,
        "text/markdown;charset=utf-8"
      );
      reportOutcome(result.stats, result.fidelity, "Downloaded");
      onClose();
    } catch {
      showToast("Export failed", "Could not reach the export endpoint.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    setBusy(true);
    try {
      const result = await fetchExport();
      if (!result) return;
      if (!navigator.clipboard) {
        showToast("Copy unavailable", "This browser blocks clipboard access.");
        return;
      }
      await navigator.clipboard.writeText(result.markdown);
      reportOutcome(result.stats, result.fidelity, "Copied");
      onClose();
    } catch {
      showToast("Export failed", "Could not reach the export endpoint.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export session as Markdown" maxWidthClass="max-w-sm">
      <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Detail level</div>
          {(["minimal", "standard", "full"] as ExportDetailLevel[]).map((l) => (
            <label key={l} style={{ ...checkboxRowStyle, alignItems: "flex-start" }}>
              <input
                type="radio"
                name="export-detail"
                checked={level === l}
                onChange={() => { setLevel(l); setThinking(null); }}
                style={{ width: "14px", height: "14px", accentColor: "var(--accent)", marginTop: "2px" }}
              />
              <span>
                <span style={{ textTransform: "capitalize" }}>{l}</span>
                <span style={{ display: "block", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  {DETAIL_BLURB[l]}
                </span>
              </span>
            </label>
          ))}
        </div>

        {data.hasThinking && (
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={thinkingChecked}
              onChange={(e) => setThinking(e.target.checked)}
              style={{ width: "14px", height: "14px", accentColor: "var(--accent)" }}
            />
            Include extended thinking
          </label>
        )}

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={handleDownload}
            disabled={busy}
            style={{
              flex: 1, padding: "8px 16px", fontSize: "0.8rem", fontWeight: 600,
              background: busy ? "var(--surface-2)" : "var(--accent)",
              color: busy ? "var(--text-muted)" : "#fff",
              border: "none", borderRadius: "var(--radius)", cursor: busy ? "wait" : "pointer",
            }}
          >
            {busy ? "Rendering…" : "Download .md"}
          </button>
          <button
            onClick={handleCopy}
            disabled={busy}
            style={{
              padding: "8px 16px", fontSize: "0.8rem", fontWeight: 600,
              background: "transparent", color: "var(--text-secondary)",
              border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Copy
          </button>
        </div>
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

/**
 * The session's permission-mode timeline, collapsed to the path it took.
 *
 * `permissionModes` was parsed by both backends and rendered by nothing. Only
 * 193 of 5,028 local sessions record one — a session that never switched mode
 * emits no entry at all, so **absence is not `auto`** and the chip is omitted
 * rather than defaulted (see SessionPermissionMode).
 *
 * Consecutive duplicates are collapsed: the entries are a log, so a session
 * that re-asserted the same mode five times took one path, not five.
 */
function PermissionModeChip({ modes }: { modes?: SessionPermissionMode[] }) {
  if (!modes || modes.length === 0) return null;

  const path = modes.reduce<string[]>((acc, m) => {
    if (acc[acc.length - 1] !== m.mode) acc.push(m.mode);
    return acc;
  }, []);

  const label = path.join(" → ");
  const explanation =
    path.length > 1
      ? `Permission mode changed during this session: ${label}`
      : `Permission mode for this session: ${label}`;

  return (
    <>
      <span className="sr-only">{explanation}</span>
      <span
        aria-hidden="true"
        title={explanation}
        style={{
          display: "inline-flex", alignItems: "center", gap: "4px",
          fontFamily: "var(--font-mono)", fontSize: "0.65rem",
          color: "var(--text-secondary)", background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)", borderRadius: "3px",
          padding: "2px 7px", cursor: "help",
        }}
      >
        <ShieldCheck style={{ width: "10px", height: "10px" }} />
        {label}
      </span>
    </>
  );
}

// Stats-strip cell now uses the shared primitive — see src/components/ui/StatCell.tsx.

// ── Tab bar ───────────────────────────────────────────────────────────────────
type TabKey = "timeline" | "tools" | "files" | "skills" | "subagents" | "orchestration" | "concurrency" | "delegation" | "network" | "handoff" | "context" | "diagnosis" | "feedback" | "hooks";

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
  const queryClient = useQueryClient();
  // Star/distill/title write to the server and update local state optimistically.
  // Without this, the detail query's 30s staleTime would serve pre-mutation data
  // on remount and the sync effect below would revert the change — so invalidate
  // the cached detail to pull the canonical server state.
  const invalidateDetail = useCallback(
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    },
    [queryClient, sessionId],
  );
  const [activeTab, setActiveTab] = useState<TabKey>("timeline");
  // Demo sessions (synthetic ids) exist only as the main detail payload; the
  // deep-analysis tabs fetch secondary endpoints that resolve the id against the
  // real JSONL/DB and 404. Hide them for demo sessions — the core tabs (timeline
  // / tools / files / skills / subagents) come from the guarded detail payload.
  // Key on the RETURNED payload id, not the URL: a demo detail opened by slug —
  // or the unknown-id fallback that serves the first fixture — has a synthetic
  // `data.sessionId` even when the route param doesn't start with "demo-".
  const isDemoSession = (data?.sessionId ?? sessionId).startsWith("demo-");
  // The context-attribution endpoint resolves transcripts via
  // `resolveSessionJsonl`, which only walks Claude's
  // `projects/<dir>/<sessionId>.jsonl`. Codex and Gemini sessions live
  // under their own adapters' directories, so the request 404s by
  // construction — the tab would be a guaranteed error for every
  // non-Claude session. Gate it on the source rather than shipping a
  // control that cannot work. Legacy rows carry no `source` and are
  // Claude by definition (see SessionSummary.source).
  const supportsContextAttribution = (data?.source ?? "claude") === "claude";
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

  const handleTitleGenerated = useCallback(
    (title: string) => { setGeneratedTitle(title); invalidateDetail(); },
    [invalidateDetail],
  );

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
  const hookRunCount = data.hookRuns?.length ?? 0;

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
    // Presence-gated only — deliberately NOT behind `!isDemoSession`. That
    // guard exists for tabs that fetch id-keyed secondary endpoints, which
    // 404 for synthetic ids; this panel derives from the detail payload
    // already in hand, and the demo fixtures carry `hookRuns` too.
    ...(hookRunCount > 0 || (data.hookErrors?.length ?? 0) > 0
      ? [{ key: "hooks" as TabKey, label: `Hooks (${hookRunCount})` }]
      : []),
    ...(data.subagentCount > 0 && !isDemoSession
      ? [{ key: "orchestration" as TabKey, label: "Orchestration" }]
      : []),
    ...(data.subagents.length > 0 && !isDemoSession
      ? ([
          { key: "concurrency", label: "Concurrency" },
          { key: "delegation",  label: "Delegation"  },
          { key: "network",     label: "Network"     },
        ] as { key: TabKey; label: string }[])
      : []),
    // Handoff / Diagnosis / Feedback fetch id-keyed endpoints that 404 for demo
    // sessions — omit them there.
    ...(!isDemoSession
      ? ([
          { key: "handoff",   label: "Handoff"   },
          { key: "diagnosis", label: "Diagnosis" },
          { key: "feedback",  label: "Feedback"  },
        ] as { key: TabKey; label: string }[])
      : []),
    ...(!isDemoSession && supportsContextAttribution
      ? ([{ key: "context", label: "Context" }] as { key: TabKey; label: string }[])
      : []),
  ];

  // A2: the session's reasoning-effort mix, reduced to one strip cell. The
  // headline is the level that ran the most turns; the detail is the full
  // histogram, which deliberately doesn't sum to `assistantMessageCount`
  // (turns predating the field carry no effort). Ties resolve to the higher
  // level via `compareEffort`, since "the session ran at xhigh" is the more
  // useful reading of an even split than the reverse.
  const effortSummary = (() => {
    const entries = Object.entries(data.effortMix ?? {}).filter(([, n]) => n > 0);
    if (entries.length === 0) return null;
    const ranked = [...entries].sort(
      ([aLevel, aN], [bLevel, bN]) => bN - aN || compareEffort(bLevel, aLevel)
    );
    return {
      dominant: ranked[0][0],
      detail: [...entries]
        .sort(([a], [b]) => compareEffort(a, b))
        .map(([level, n]) => `${n} ${level}`)
        .join(" · "),
    };
  })();

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
    // A2. Omitted entirely when the session recorded no effort — most of this
    // corpus predates the field, and a cell reading "unknown" would occupy the
    // strip on every older session while adding nothing.
    ...(effortSummary ? [{
      label: "Effort",
      value: effortSummary.dominant,
      detail: effortSummary.detail,
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
          onToggle={(v) => { setStarredAt(v); invalidateDetail(); }}
        />
        <DistillButton
          sessionId={sessionId}
          hasDistillation={!!distilledText}
          onDistilled={(text, at) => { setDistilledText(text); setDistilledAt(at); invalidateDetail(); }}
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
          <PermissionModeChip modes={data.permissionModes} />
        </div>

        {/* Title subtitle. Minder's own generated title wins when present;
            otherwise Claude Code's `aiTitle`, which arrives in the transcript
            for free and was previously read, typed, and dropped — the page
            offered to generate a title while one sat unused in the payload.
            Attributed rather than blended, because a title you asked Minder to
            write and one Claude Code emitted are different provenance. */}
        {(generatedTitle || data.aiTitle) && (
          <p style={{
            fontSize: "0.82rem", color: "var(--accent)",
            margin: 0, lineHeight: 1.4,
            fontFamily: "var(--font-body)", fontWeight: 500,
            display: "flex", alignItems: "baseline", gap: "7px",
          }}>
            {generatedTitle ?? data.aiTitle}
            {!generatedTitle && data.aiTitle && (
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: "0.58rem",
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: "var(--text-muted)", fontWeight: 400,
              }}>
                from Claude Code
              </span>
            )}
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

      {/* ── Session metadata panel (Claude Code's own per-session record) ───── */}
      {data.sessionMeta && <SessionMetaPanel meta={data.sessionMeta} />}

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
              {/* The telemetry cards query the OTEL SQLite tables by session id;
                  demo sessions aren't in the index (and a first-run demo has no
                  index at all), so they'd render 500-backed error cards. Skip
                  them for demo — the tool-usage bar chart comes from the payload. */}
              {!isDemoSession && (
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
              )}
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

          {activeTab === "hooks" && (
            <SessionHooksPanel hookRuns={data.hookRuns} hookErrors={data.hookErrors} />
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

          {activeTab === "context" && (
            <ContextAttributionPanel sessionId={data.sessionId} />
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
