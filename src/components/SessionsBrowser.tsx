"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAllSessions } from "@/hooks/useSessions";
import { useHoverPrefetch } from "@/hooks/useHoverPrefetch";
import { sessionDetailQuery } from "@/lib/queryOptions";
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
  Pencil,
  Star,
} from "lucide-react";
import Link from "next/link";
import { StatusDot } from "./ui/StatusDot";
import { FILE_OP_BY_TOOL, isFileWriteOp } from "@/lib/usage/toolNames";
import { formatCost, formatDurationMsCompact as formatDuration, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";
import { StackedStrip } from "@/components/stats/StackedStrip";
import { WORK_MODE_SEGMENTS } from "@/lib/usage/workMode";
import { SourceBadge } from "@/components/SourceBadge";
import { EffortMixChip } from "@/components/EffortMixChip";
import { EntrypointChip } from "@/components/EntrypointChip";

type SortOption = "relevance" | "recent" | "longest" | "tokens" | "oneshot";

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

// ── Quality chips (cache hit %, compaction loop, tool-failure streak) ───────────

type QualityChipTone = "good" | "neutral" | "warn" | "error";

function QualityChip({
  tone,
  title,
  children,
}: {
  tone: QualityChipTone;
  title: string;
  children: React.ReactNode;
}) {
  const tokens =
    tone === "good"
      ? { color: "var(--status-active-text)", bg: "var(--status-active-bg)", border: "var(--status-active-border)" }
      : tone === "warn"
        ? { color: "var(--accent)", bg: "var(--accent-bg)", border: "var(--accent-border)" }
        : tone === "error"
          ? { color: "var(--status-error-text)", bg: "var(--status-error-bg)", border: "var(--status-error-border)" }
          : { color: "var(--text-secondary)", bg: "var(--bg-elevated)", border: "var(--border-subtle)" };
  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        color: tokens.color,
        background: tokens.bg,
        border: `1px solid ${tokens.border}`,
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

function CacheHitBadge({ ratio }: { ratio: number }) {
  // Per Clauditor's >70% benchmark: green at 0.7+ (cache paying back),
  // amber below 0.5 (rebuilds dominating), neutral in between.
  const tone: QualityChipTone = ratio >= 0.7 ? "good" : ratio >= 0.5 ? "neutral" : "warn";
  return (
    <QualityChip tone={tone} title="Cache hit ratio (cache_read / total cache traffic). >70% is healthy.">
      {(ratio * 100).toFixed(0)}% cache
    </QualityChip>
  );
}

function CompactionLoopBadge() {
  return (
    <QualityChip tone="error" title="Compaction loop detected — Claude was burning tokens cycling on the same context without progress.">
      compaction loop
    </QualityChip>
  );
}

function ToolFailureStreakBadge() {
  return (
    <QualityChip tone="error" title="Tool-failure streak detected — 5+ consecutive tool calls errored at >50% rate.">
      tool fail streak
    </QualityChip>
  );
}

function ResumeAnomalyBadge() {
  return (
    <QualityChip tone="warn" title="Resume anomaly detected — large output token spike after a compact boundary, suggesting context reconstruction.">
      resume anomaly
    </QualityChip>
  );
}

function ThinkingBadge() {
  return (
    <QualityChip tone="neutral" title="Session contained thinking blocks (extended reasoning).">
      thinking
    </QualityChip>
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

// Title-class match: any of the fields a user typically searches BY name
// rather than BY content. Single source of truth for both the row's
// "show snippet vs. show prompt" decision and the outer filter — they
// were drifting (slug was added to one but not the other).
function matchesTitleScope(s: SessionSummary, q: string): boolean {
  return (
    s.initialPrompt?.toLowerCase().includes(q) === true ||
    s.lastPrompt?.toLowerCase().includes(q) === true ||
    s.projectName.toLowerCase().includes(q) ||
    s.projectPath.toLowerCase().includes(q) ||
    s.sessionId.includes(q) ||
    s.gitBranch?.toLowerCase().includes(q) === true ||
    s.slug?.toLowerCase().includes(q) === true
  );
}

// ── Session row ───────────────────────────────────────────────────────────────
function SessionRow({
  session,
  showProject = true,
  search = "",
  ftsSnippet,
}: {
  session: SessionSummary;
  showProject?: boolean;
  search?: string;
  /** FTS5 excerpt of the matched text, when the server returned one. */
  ftsSnippet?: string;
}) {
  const { currency, fxRate } = useCurrency();
  const prefetch = useHoverPrefetch();
  // Warm the session-detail query when the user hovers/focuses the row, so the
  // detail page mounts from cache instead of waiting on /api/sessions/[id].
  const warmDetail = useCallback(
    () => prefetch(sessionDetailQuery(session.sessionId)),
    [prefetch, session.sessionId],
  );
  const totalTools = Object.values(session.toolUsage).reduce((s, c) => s + c, 0);
  const totalEdits = Object.entries(FILE_OP_BY_TOOL)
    .filter(([, op]) => isFileWriteOp(op))
    .reduce((sum, [name]) => sum + (session.toolUsage[name] ?? 0), 0);
  const trimmedSearch = search.trim();
  const searchLower = trimmedSearch.toLowerCase();
  // Prefer the server's excerpt: it comes from the full indexed text, so
  // it can show WHY a session matched even when the match lies past the
  // 500-char preview, inside thinking, or inside a subagent transcript —
  // none of which `searchableText` contains. The local check remains the
  // fallback for the file backend (MINDER_USE_DB=0), which has no FTS and
  // therefore no snippet.
  const localContentMatch = trimmedSearch
    ? !!(session.searchableText?.toLowerCase().includes(searchLower)) &&
      !matchesTitleScope(session, searchLower)
    : false;
  const snippetText = ftsSnippet ?? (localContentMatch ? session.searchableText : undefined);

  return (
    <Link
      href={`/sessions/${session.sessionId}`}
      style={{ display: "block", textDecoration: "none" }}
      onMouseEnter={warmDetail}
      onFocus={warmDetail}
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
          {session.starredAt && (
            <span title={`Starred ${new Date(session.starredAt).toLocaleDateString()}`} style={{ display: "inline-flex", flexShrink: 0, marginTop: "2px" }}>
              <Star style={{ width: "10px", height: "10px", color: "var(--accent)", fill: "var(--accent)" }} />
            </span>
          )}
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
          {session.isWorktree && session.gitBranch && (
            <QualityChip tone="neutral" title={`Worktree session — branch: ${session.gitBranch}`}>
              {session.gitBranch}
            </QualityChip>
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
            {trimmedSearch && snippetText
              ? <MatchSnippet text={snippetText} query={trimmedSearch} />
              : session.recaps && session.recaps.length > 0
              ? session.recaps[session.recaps.length - 1].content
              : session.generatedTitle ?? session.initialPrompt ?? session.lastPrompt ?? session.gitBranch ?? (
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
            {formatCost(session.costEstimate, currency, fxRate)}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <Wrench style={{ width: "10px", height: "10px" }} />
            {totalTools}
          </span>
          {totalEdits > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <Pencil style={{ width: "10px", height: "10px" }} />
              {totalEdits} edits
            </span>
          )}
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
          {session.continuedFromSessionId && (
            <span
              title={`Continued from session ${session.continuedFromSessionId}`}
              style={{
                fontSize: "0.65rem",
                fontFamily: "var(--font-mono)",
                color: "var(--accent)",
                background: "var(--accent-bg)",
                border: "1px solid var(--accent-border)",
                borderRadius: "3px",
                padding: "1px 5px",
                flexShrink: 0,
              }}
            >
              continued
            </span>
          )}
          {session.cacheHitRatio !== undefined && (
            <CacheHitBadge ratio={session.cacheHitRatio} />
          )}
          {session.hasCompactionLoop && <CompactionLoopBadge />}
          {session.hasToolFailureStreak && <ToolFailureStreakBadge />}
          {session.hasResumeAnomaly && <ResumeAnomalyBadge />}
          {session.hasThinking && <ThinkingBadge />}
          {session.oneShotRate !== undefined && (
            <OneShotBadge rate={session.oneShotRate} />
          )}
          <EffortMixChip mix={session.effortMix} />
          <EntrypointChip entrypoint={session.entrypoint} sessionKind={session.sessionKind} />
          <SourceBadge source={session.source} />
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
          {session.workMode && (
            <div style={{ marginLeft: "auto", flexShrink: 0 }}>
              <StackedStrip width={64} height={5} title="Work-mode breakdown" segments={WORK_MODE_SEGMENTS(session.workMode)} />
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

// ── Project group section ─────────────────────────────────────────────────────
interface ProjectGroup {
  projectPath: string;
  projectName: string;
  projectSlug: string;
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
    const list = map.get(s.projectSlug) ?? [];
    list.push(s);
    map.set(s.projectSlug, list);
  }

  const groups: ProjectGroup[] = [];
  for (const [projectSlug, projectSessions] of map) {
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
      projectPath: projectSessions[0].projectPath,
      projectName: projectSessions[0].projectName,
      projectSlug,
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
  const { currency, fxRate } = useCurrency();
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
        href={`/project/${group.projectSlug}`}
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
        {formatTokens(group.totalTokens)} · {formatCost(group.totalCost, currency, fxRate)} · {formatDuration(group.totalDurationMs)}
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
const SEARCH_DEBOUNCE_MS = 250;
// Minimum query length before the FTS request fires. Shared with the
// relevance-sort switch so the two can't drift apart.
const MIN_SEARCH_CHARS = 2;

interface SearchApiResponse {
  hits: Array<{
    sessionId: string;
    score: number;
    source: "titles" | "prompts";
    snippet?: string;
  }>;
  backend: "db" | "file";
}

// Single source of truth for the FTS-backed search state. Replacing
// the prior split (`serverHitIds: Set | null` + `searchBackend:
// "db"|"file"|"unknown"`) which could disagree on error paths — a
// network failure marked the backend "file" while a pending fetch
// could still flip it back to "db", or vice-versa, leaving the FTS
// badge stuck on or off.
type SearchState =
  | { kind: "idle" } //  query under the 2-char gate
  | { kind: "pending" } //  fetch in flight
  //  FTS-backed hits. A Map rather than a Set so RRF ordering survives:
  //  `rank` is the hit's 0-based position from the API, which the
  //  `relevance` sort reads. Keeping only a Set discarded the ranking the
  //  server just computed, so a prompt-only hit could outrank a
  //  dual-retriever one in the list. `.has()` works the same, so the
  //  membership filter below is unchanged.
  //
  //  `snippet` is FTS5's excerpt of the matched text. It is the ONLY
  //  source of an excerpt for content the row can't otherwise see:
  //  `searchableText` is built from `turns.text_preview` (500 chars,
  //  and sidechain rows are excluded outright), so matches deep in a
  //  body, in extended thinking, or in a subagent transcript have no
  //  local text to highlight.
  | { kind: "db"; ids: Map<string, { rank: number; snippet?: string }> }
  | { kind: "file" }; //  MINDER_USE_DB=0 OR fetch failed

export function SessionsBrowser() {
  const { data, loading } = useAllSessions();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [groupByProject, setGroupByProject] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(new Set());
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < MIN_SEARCH_CHARS) {
      setSearchState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchState({ kind: "pending" });
      try {
        const params = new URLSearchParams({ q: trimmed, scope: "both", limit: "200" });
        const res = await fetch(`/api/sessions/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setSearchState({ kind: "file" });
          return;
        }
        const json = (await res.json()) as SearchApiResponse;
        if (controller.signal.aborted) return;
        if (json.backend === "file") {
          setSearchState({ kind: "file" });
        } else {
          // Preserve the server's RRF ordering as rank indices. `hits` is
          // already sorted best-first by `searchSessionsInDb`.
          setSearchState({
            kind: "db",
            ids: new Map(
              json.hits.map((h, i) => [h.sessionId, { rank: i, snippet: h.snippet }])
            ),
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setSearchState({ kind: "file" });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  // Relevance ordering is only meaningful while a search is active, so it
  // becomes the sort when one starts and steps back down when it ends.
  // Guarded on `prev` so it only ever replaces the DEFAULT sort — a user
  // who explicitly picked "Most tokens" keeps it through the search, and
  // one who explicitly picked relevance isn't stranded on a dead sort
  // once the query is cleared.
  useEffect(() => {
    const active = search.trim().length >= MIN_SEARCH_CHARS;
    setSortBy((prev) => {
      if (active && prev === "recent") return "relevance";
      if (!active && prev === "relevance") return "recent";
      return prev;
    });
  }, [search]);

  const availableSources = useMemo(() => {
    const srcs = new Set(data.map((s) => s.source ?? "claude"));
    return [...srcs].sort();
  }, [data]);

  const filtered = useMemo(() => {
    let result = data;
    if (starredOnly) {
      result = result.filter((s) => !!s.starredAt);
    }
    if (sourceFilter !== "all") {
      result = result.filter((s) => (s.source ?? "claude") === sourceFilter);
    }
    const trimmed = search.trim();
    if (trimmed) {
      const q = trimmed.toLowerCase();
      const ftsIds = searchState.kind === "db" ? searchState.ids : null;
      result = result.filter(
        (s) =>
          ftsIds?.has(s.sessionId) ||
          matchesTitleScope(s, q) ||
          s.searchableText?.toLowerCase().includes(q)
      );
    }
    const rank = searchState.kind === "db" ? searchState.ids : null;
    const endedAt = (s: typeof result[number]) =>
      s.endTime ? new Date(s.endTime).getTime() : 0;
    return [...result].sort((a, b) => {
      switch (sortBy) {
        case "relevance": {
          // Server-computed RRF order. Sessions matched only client-side
          // (title substring / cached searchableText) carry no rank, so
          // they sort after every ranked hit rather than jumping to the
          // top on a rank of 0 — then fall back to recency among
          // themselves so the tail stays deterministic.
          const ra = rank?.get(a.sessionId)?.rank ?? Number.MAX_SAFE_INTEGER;
          const rb = rank?.get(b.sessionId)?.rank ?? Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return endedAt(b) - endedAt(a);
        }
        case "longest": return (b.durationMs || 0) - (a.durationMs || 0);
        case "tokens":  return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
        case "oneshot": {
          if (a.oneShotRate === undefined && b.oneShotRate === undefined) return 0;
          if (a.oneShotRate === undefined) return 1;
          if (b.oneShotRate === undefined) return -1;
          return b.oneShotRate - a.oneShotRate;
        }
        default: return endedAt(b) - endedAt(a);
      }
    });
  }, [data, search, sortBy, searchState, starredOnly, sourceFilter]);

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

  const allCollapsed = projectGroups.length > 0 && projectGroups.every((g) => collapsedSlugs.has(g.projectSlug));

  // Flatten the (possibly grouped) tree into a single positional array so one
  // virtualizer can drive both render modes. Recomputes only when the inputs
  // change (filtered list, grouping, or which sections are collapsed).
  const flatItems = useMemo<FlatItem[]>(() => {
    if (!groupByProject) {
      return filtered.map((s) => ({ kind: "row" as const, session: s, showProject: true }));
    }
    const items: FlatItem[] = [];
    for (const group of projectGroups) {
      const collapsed = collapsedSlugs.has(group.projectSlug);
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
    // Offered only while the FTS backend is actually serving ranked hits.
    // Under `MINDER_USE_DB=0` (or a failed request) matching is
    // client-side substring filtering with no ranking at all, so the
    // option would be a button that silently does nothing.
    ...(searchState.kind === "db"
      ? ([{ value: "relevance", label: "Relevance" }] as { value: SortOption; label: string }[])
      : []),
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
            style={{ width: "100%", height: "32px", paddingLeft: "30px", paddingRight: searchState.kind === "db" ? "60px" : "10px", fontSize: "0.78rem", fontFamily: "var(--font-body)", color: "var(--text-primary)", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", outline: "none" }}
          />
          {searchState.kind === "db" && (
            <span
              title="Full-text search is querying the SQLite FTS5 index (matches session content beyond the cached preview)."
              style={{
                position: "absolute",
                right: "9px",
                top: "50%",
                transform: "translateY(-50%)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                color: "var(--accent)",
                background: "var(--accent-bg)",
                border: "1px solid var(--accent-border)",
                borderRadius: "3px",
                padding: "1px 5px",
                pointerEvents: "none",
              }}
            >
              FTS
            </span>
          )}
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

        {/* Starred filter */}
        <button
          onClick={() => setStarredOnly((v) => !v)}
          title={starredOnly ? "Show all sessions" : "Show starred only"}
          style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", fontSize: "0.72rem", fontFamily: "var(--font-body)", letterSpacing: "0.03em", color: starredOnly ? "var(--accent)" : "var(--text-secondary)", background: starredOnly ? "var(--accent-bg)" : "var(--bg-surface)", border: `1px solid ${starredOnly ? "var(--accent-border)" : "var(--border-subtle)"}`, borderRadius: "var(--radius)", cursor: "pointer", transition: "background 0.1s, color 0.1s, border-color 0.1s", lineHeight: 1, flexShrink: 0 }}
        >
          <Star style={{ width: "10px", height: "10px", fill: starredOnly ? "currentColor" : "none" }} />
          Starred
        </button>

        {/* Source filter */}
        {availableSources.length > 0 && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={{ padding: "5px 8px", fontSize: "0.72rem", fontFamily: "var(--font-body)", color: sourceFilter !== "all" ? "var(--accent)" : "var(--text-secondary)", background: "var(--bg-surface)", border: `1px solid ${sourceFilter !== "all" ? "var(--accent-border)" : "var(--border-subtle)"}`, borderRadius: "var(--radius)", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}
          >
            <option value="all">All sources</option>
            {availableSources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}

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
            onClick={() => allCollapsed ? setCollapsedSlugs(new Set()) : setCollapsedSlugs(new Set(projectGroups.map((g) => g.projectSlug)))}
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
                      onToggle={() => toggleCollapse(item.group.projectSlug)}
                    />
                  ) : (
                    <SessionRow
                      session={item.session}
                      showProject={item.showProject}
                      search={search}
                      ftsSnippet={
                        searchState.kind === "db"
                          ? searchState.ids.get(item.session.sessionId)?.snippet
                          : undefined
                      }
                    />
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
