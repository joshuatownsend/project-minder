"use client";

import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAllSessions } from "@/hooks/useSessions";
import { SessionSummary } from "@/lib/types";
import {
  Search,
  Clock,
  Cpu,
  MessageSquare,
  GitBranch,
  Bot,
  Wrench,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Terminal,
  Check,
} from "lucide-react";
import Link from "next/link";
import { StatusDot } from "./ui/StatusDot";

type SortOption = "recent" | "longest" | "tokens" | "oneshot";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
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

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// ── Resume button ─────────────────────────────────────────────────────────────
function ResumeButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 7px",
        fontSize: "0.65rem",
        fontFamily: "var(--font-body)",
        letterSpacing: "0.03em",
        color: copied ? "var(--status-active-text)" : "var(--text-muted)",
        background: copied ? "var(--status-active-bg)" : "transparent",
        border: `1px solid ${copied ? "var(--status-active-border)" : "var(--border-subtle)"}`,
        borderRadius: "3px",
        cursor: "pointer",
        flexShrink: 0,
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
      }}
    >
      {copied
        ? <><Check style={{ width: "9px", height: "9px" }} />Copied</>
        : <><Terminal style={{ width: "9px", height: "9px" }} />Resume</>}
    </button>
  );
}

// ── One-shot rate badge ───────────────────────────────────────────────────────
function OneShotBadge({ rate }: { rate: number }) {
  const color =
    rate >= 0.8
      ? "var(--status-active-text)"
      : rate >= 0.5
      ? "var(--accent)"
      : "var(--status-error-text)";
  const bg =
    rate >= 0.8
      ? "var(--status-active-bg)"
      : rate >= 0.5
      ? "var(--accent-bg)"
      : "var(--status-error-bg)";
  const border =
    rate >= 0.8
      ? "var(--status-active-border)"
      : rate >= 0.5
      ? "var(--accent-border)"
      : "var(--status-error-border)";

  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        color,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {(rate * 100).toFixed(0)}% 1-shot
    </span>
  );
}

// ActiveDot used for project group headers (always green — the group has at least one active session).
function ActiveDot() {
  return <StatusDot status="working" size={8} />;
}

// Highlight a matched query within a text snippet.
function MatchSnippet({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{text.slice(0, 80)}</span>;
  const start = Math.max(0, idx - 30);
  const end   = Math.min(text.length, idx + query.length + 50);
  const before = text.slice(start, idx);
  const match  = text.slice(idx, idx + query.length);
  const after  = text.slice(idx + query.length, end);
  return (
    <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
      {start > 0 && "…"}{before}
      <mark style={{ background: "var(--accent-bg)", color: "var(--accent)", borderRadius: "2px", padding: "0 1px" }}>{match}</mark>
      {after}{end < text.length && "…"}
    </span>
  );
}

// ── Session row ───────────────────────────────────────────────────────────────
function SessionRow({
  session,
  showProject = true,
  search = "",
}: {
  session: SessionSummary;
  showProject?: boolean;
  search?: string;
}) {
  const totalTools = Object.values(session.toolUsage).reduce((s, c) => s + c, 0);
  const searchLower = search.toLowerCase();
  const isContentMatch = search
    ? !!(session.searchableText?.toLowerCase().includes(searchLower))
      && !session.initialPrompt?.toLowerCase().includes(searchLower)
      && !session.lastPrompt?.toLowerCase().includes(searchLower)
      && !session.projectName.toLowerCase().includes(searchLower)
      && !session.gitBranch?.toLowerCase().includes(searchLower)
    : false;

  return (
    <Link
      href={`/sessions/${session.sessionId}`}
      style={{ display: "block", textDecoration: "none" }}
    >
      <div
        style={{
          padding: "10px 6px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "5px",
          transition: "background 0.1s",
          borderRadius: "3px",
          cursor: "pointer",
        }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLElement).style.background = "transparent")
        }
      >
        {/* Top line: project (if flat) + prompt + date */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
          {showProject && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--text-secondary)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px",
                padding: "1px 5px",
                flexShrink: 0,
                marginTop: "1px",
              }}
            >
              {session.projectName}
            </span>
          )}
          <StatusDot status={session.status} size={8} />
          {session.recaps && session.recaps.length > 0 && (
            <span style={{
              fontSize: "0.6rem", fontFamily: "var(--font-mono)",
              fontWeight: 600, letterSpacing: "0.04em",
              color: "var(--accent)", background: "var(--accent-bg)",
              border: "1px solid var(--accent-border)",
              borderRadius: "3px", padding: "1px 5px",
              flexShrink: 0,
            }}>
              recap
            </span>
          )}
          <span
            style={{
              flex: 1,
              fontSize: "0.8rem",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isContentMatch && session.searchableText
              ? <MatchSnippet text={session.searchableText} query={search} />
              : session.recaps && session.recaps.length > 0
              ? session.recaps[session.recaps.length - 1].content
              : session.initialPrompt ?? session.lastPrompt ?? session.gitBranch ?? (
                <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>no prompt recorded</span>
              )}
          </span>
          <ResumeButton sessionId={session.sessionId} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {formatDate(session.startTime)}
          </span>
        </div>

        {/* Stats line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
            paddingLeft: showProject ? "0" : "0",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <Clock style={{ width: "10px", height: "10px" }} />
            {formatDuration(session.durationMs)}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <MessageSquare style={{ width: "10px", height: "10px" }} />
            {session.messageCount}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <Cpu style={{ width: "10px", height: "10px" }} />
            {formatTokens(session.inputTokens + session.outputTokens)}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <DollarSign style={{ width: "10px", height: "10px" }} />
            {formatCost(session.costEstimate)}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <Wrench style={{ width: "10px", height: "10px" }} />
            {totalTools}
          </span>
          {session.subagentCount > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <Bot style={{ width: "10px", height: "10px" }} />
              {session.subagentCount}
            </span>
          )}
          {session.errorCount > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--status-error-text)", fontFamily: "var(--font-mono)" }}>
              <AlertCircle style={{ width: "10px", height: "10px" }} />
              {session.errorCount}
            </span>
          )}
          {session.gitBranch && (
            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <GitBranch style={{ width: "10px", height: "10px" }} />
              {session.gitBranch}
            </span>
          )}
          {session.oneShotRate !== undefined && (
            <OneShotBadge rate={session.oneShotRate} />
          )}
          {session.modelsUsed.slice(0, 1).map((m) => (
            <span
              key={m}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                color: "var(--text-muted)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px",
                padding: "1px 4px",
              }}
            >
              {m}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

// ── Project group section ─────────────────────────────────────────────────────
interface ProjectGroup {
  projectPath: string;
  projectName: string;
  sessions: SessionSummary[];
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  activeSessions: number;
  lastActivity?: string;
  avgOneShotRate?: number;
}

function buildProjectGroups(sessions: SessionSummary[]): ProjectGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const list = map.get(s.projectPath) ?? [];
    list.push(s);
    map.set(s.projectPath, list);
  }

  const groups: ProjectGroup[] = [];
  for (const [projectPath, projectSessions] of map) {
    let totalTokens = 0, totalCost = 0, totalDurationMs = 0, activeSessions = 0;
    let lastActivity: string | undefined;
    const oneShotRates: number[] = [];

    for (const s of projectSessions) {
      totalTokens += s.inputTokens + s.outputTokens;
      totalCost += s.costEstimate;
      totalDurationMs += s.durationMs || 0;
      if (s.isActive) activeSessions++;
      if (s.endTime && (!lastActivity || s.endTime > lastActivity)) lastActivity = s.endTime;
      if (s.oneShotRate !== undefined) oneShotRates.push(s.oneShotRate);
    }

    groups.push({
      projectPath,
      projectName: projectSessions[0].projectName,
      sessions: projectSessions,
      totalTokens,
      totalCost,
      totalDurationMs,
      activeSessions,
      lastActivity,
      avgOneShotRate: oneShotRates.length > 0
        ? oneShotRates.reduce((a, b) => a + b, 0) / oneShotRates.length
        : undefined,
    });
  }

  return groups.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });
}

function SectionHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        paddingBottom: "10px",
        paddingTop: "14px",
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.projectName} sessions`}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "16px", height: "16px",
          background: "transparent", border: "none",
          color: "var(--text-muted)", cursor: "pointer", padding: 0, flexShrink: 0,
        }}
      >
        {collapsed
          ? <ChevronRight style={{ width: "12px", height: "12px" }} />
          : <ChevronDown style={{ width: "12px", height: "12px" }} />}
      </button>

      <Link
        href={`/project/${group.projectName}`}
        style={{
          fontSize: "0.78rem", fontWeight: 600, letterSpacing: "0.02em",
          textTransform: "uppercase", color: "var(--text-primary)", textDecoration: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {group.projectName}
      </Link>

      {group.activeSessions > 0 && <ActiveDot />}

      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
        {group.sessions.length}
      </span>

      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
        {formatTokens(group.totalTokens)} · {formatCost(group.totalCost)} · {formatDuration(group.totalDurationMs)}
      </span>

      {group.avgOneShotRate !== undefined && (
        <OneShotBadge rate={group.avgOneShotRate} />
      )}

      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />

      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)", flexShrink: 0 }}>
        {formatDate(group.lastActivity)}
      </span>
    </div>
  );
}

// Flat item kinds — the virtualized list renders these in order. Headers and
// session rows interleave in grouped mode; only rows appear in flat mode.
type FlatItem =
  | { kind: "header"; group: ProjectGroup; collapsed: boolean }
  | { kind: "row"; session: SessionSummary; showProject: boolean };

// ── Main browser ──────────────────────────────────────────────────────────────
export function SessionsBrowser() {
  const { data, loading } = useAllSessions();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [groupByProject, setGroupByProject] = useState(true);
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    let result = data;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.initialPrompt?.toLowerCase().includes(q) ||
          s.lastPrompt?.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q) ||
          s.projectPath.toLowerCase().includes(q) ||
          s.sessionId.includes(q) ||
          s.gitBranch?.toLowerCase().includes(q) ||
          s.searchableText?.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      switch (sortBy) {
        case "longest": return (b.durationMs || 0) - (a.durationMs || 0);
        case "tokens":  return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
        case "oneshot": {
          if (a.oneShotRate === undefined && b.oneShotRate === undefined) return 0;
          if (a.oneShotRate === undefined) return 1;
          if (b.oneShotRate === undefined) return -1;
          return b.oneShotRate - a.oneShotRate;
        }
        default: {
          const ta = a.endTime ? new Date(a.endTime).getTime() : 0;
          const tb = b.endTime ? new Date(b.endTime).getTime() : 0;
          return tb - ta;
        }
      }
    });
  }, [data, search, sortBy]);

  const projectGroups = useMemo(
    () => groupByProject ? buildProjectGroups(filtered) : [],
    [filtered, groupByProject]
  );

  const activeSessions = useMemo(
    () => data.filter((s) => s.status === "working" || s.status === "needs_attention").length,
    [data]
  );

  const toggleCollapse = (path: string) => {
    setCollapsedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const allCollapsed = projectGroups.length > 0 && projectGroups.every((g) => collapsedSlugs.has(g.projectPath));

  // Flatten the (possibly grouped) tree into a single positional array so one
  // virtualizer can drive both render modes. Recomputes only when the inputs
  // change (filtered list, grouping, or which sections are collapsed).
  const flatItems = useMemo<FlatItem[]>(() => {
    if (!groupByProject) {
      return filtered.map((s) => ({ kind: "row" as const, session: s, showProject: true }));
    }
    const items: FlatItem[] = [];
    for (const group of projectGroups) {
      const collapsed = collapsedSlugs.has(group.projectPath);
      items.push({ kind: "header", group, collapsed });
      if (!collapsed) {
        for (const session of group.sessions) {
          items.push({ kind: "row", session, showProject: false });
        }
      }
    }
    return items;
  }, [filtered, projectGroups, collapsedSlugs, groupByProject]);

  // Window-relative scroll container. We use an inner scrollable region rather
  // than window-virtualizer so we don't have to manage scrollMargin against
  // the page header on every render.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollContainerRef.current,
    // 70px row, 50px header — measureElement corrects after first paint.
    estimateSize: (index) => (flatItems[index]?.kind === "header" ? 50 : 70),
    overscan: 6,
  });

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "recent",  label: "Recent" },
    { value: "longest", label: "Longest" },
    { value: "tokens",  label: "Tokens" },
    { value: "oneshot", label: "Best 1-shot" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <MessageSquare style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h1 style={{ fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", fontFamily: "var(--font-body)" }}>
          Sessions
        </h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          {data.length} total
        </span>
        {activeSessions > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: "5px", fontFamily: "var(--font-mono)", fontSize: "0.65rem", fontWeight: 500, color: "var(--status-active-text)", background: "var(--status-active-bg)", border: "1px solid var(--status-active-border)", borderRadius: "3px", padding: "2px 6px" }}>
            <ActiveDot />
            {activeSessions} active
          </span>
        )}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
          <Search style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", width: "13px", height: "13px", color: "var(--text-muted)", pointerEvents: "none" }} />
          <input
            type="text"
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", height: "32px", paddingLeft: "30px", paddingRight: "10px", fontSize: "0.78rem", fontFamily: "var(--font-body)", color: "var(--text-primary)", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", outline: "none" }}
          />
        </div>

        {/* Sort */}
        <div style={{ display: "flex", alignItems: "center", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0 }}>
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              style={{ padding: "5px 11px", fontSize: "0.72rem", fontWeight: sortBy === opt.value ? 600 : 400, fontFamily: "var(--font-body)", letterSpacing: "0.03em", color: sortBy === opt.value ? "var(--text-primary)" : "var(--text-secondary)", background: sortBy === opt.value ? "var(--bg-elevated)" : "transparent", border: "none", borderRight: "1px solid var(--border-subtle)", cursor: "pointer", transition: "background 0.1s, color 0.1s", lineHeight: 1 }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Group by project toggle */}
        <button
          onClick={() => setGroupByProject((v) => !v)}
          style={{ padding: "5px 11px", fontSize: "0.72rem", fontFamily: "var(--font-body)", letterSpacing: "0.03em", color: groupByProject ? "var(--status-active-text)" : "var(--text-secondary)", background: groupByProject ? "var(--status-active-bg)" : "var(--bg-surface)", border: `1px solid ${groupByProject ? "var(--status-active-border)" : "var(--border-subtle)"}`, borderRadius: "var(--radius)", cursor: "pointer", transition: "background 0.1s, color 0.1s, border-color 0.1s", lineHeight: 1, flexShrink: 0 }}
        >
          By project
        </button>

        {/* Collapse all */}
        {groupByProject && projectGroups.length > 1 && (
          <button
            onClick={() => allCollapsed ? setCollapsedSlugs(new Set()) : setCollapsedSlugs(new Set(projectGroups.map((g) => g.projectPath)))}
            style={{ padding: "5px 11px", fontSize: "0.72rem", fontFamily: "var(--font-body)", letterSpacing: "0.03em", color: "var(--text-secondary)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {/* ── Meta row ─────────────────────────────────────────────────────────── */}
      {!loading && (
        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: "-8px" }}>
          {filtered.length} session{filtered.length !== 1 ? "s" : ""}
          {groupByProject && projectGroups.length > 0 ? `, ${projectGroups.length} projects` : ""}
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ height: "56px", background: "var(--bg-surface)", borderRadius: "var(--radius)", animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
          <MessageSquare style={{ width: "28px", height: "28px", color: "var(--text-muted)", opacity: 0.4 }} />
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>No sessions found.</p>
          {search && <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", opacity: 0.6 }}>Try a different search term.</p>}
        </div>
      ) : (
        // Virtualized list — only rows currently in (or near) the viewport are
        // mounted. Holds DOM size constant regardless of session count.
        <div
          ref={scrollContainerRef}
          style={{
            // Fill the remaining viewport. The 220px reserve covers the page
            // header band + this component's own header/meta rows.
            height: "calc(100vh - 220px)",
            minHeight: "400px",
            overflowY: "auto",
            // Visually unobtrusive scroll container (no border / shadow).
            borderTop: groupByProject ? "none" : "1px solid var(--border-subtle)",
          }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const item = flatItems[vItem.index];
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                    paddingLeft: item.kind === "row" && !item.showProject ? "26px" : "0",
                  }}
                >
                  {item.kind === "header" ? (
                    <SectionHeader
                      group={item.group}
                      collapsed={item.collapsed}
                      onToggle={() => toggleCollapse(item.group.projectPath)}
                    />
                  ) : (
                    <SessionRow session={item.session} showProject={item.showProject} search={search} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
