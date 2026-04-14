"use client";

import { useState, useMemo } from "react";
import { useAllSessions } from "@/hooks/useSessions";
import { SessionSummary } from "@/lib/types";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import {
  Search,
  Clock,
  Cpu,
  MessageSquare,
  GitBranch,
  Bot,
  Wrench,
  SortAsc,
  AlertCircle,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Layers,
} from "lucide-react";
import Link from "next/link";

type SortOption = "recent" | "longest" | "tokens" | "oneshot";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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

// ─── Session Card ────────────────────────────────────────────────────

function SessionCard({
  session,
  showProject = true,
}: {
  session: SessionSummary;
  showProject?: boolean;
}) {
  const totalTools = Object.values(session.toolUsage).reduce((s, c) => s + c, 0);

  return (
    <Link href={`/sessions/${session.sessionId}`}>
      <div className="rounded-lg border bg-[var(--card)] p-4 hover:shadow-md transition-shadow cursor-pointer space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {session.isActive && (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </span>
            )}
            {showProject && (
              <span className="text-xs text-[var(--muted-foreground)] font-mono truncate">
                {session.projectName}
              </span>
            )}
          </div>
          <span className="text-xs text-[var(--muted-foreground)] shrink-0">
            {formatDate(session.startTime)}
          </span>
        </div>

        {session.initialPrompt && (
          <p className="text-sm line-clamp-2">{session.initialPrompt}</p>
        )}

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(session.durationMs)}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {session.messageCount}
          </span>
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            {formatTokens(session.inputTokens + session.outputTokens)}
          </span>
          <span className="flex items-center gap-1">
            <Wrench className="h-3 w-3" />
            {totalTools}
          </span>
          {session.subagentCount > 0 && (
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" />
              {session.subagentCount}
            </span>
          )}
          {session.errorCount > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle className="h-3 w-3" />
              {session.errorCount}
            </span>
          )}
          {session.oneShotRate !== undefined && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              session.oneShotRate >= 0.8 ? "bg-emerald-500/20 text-emerald-400" :
              session.oneShotRate >= 0.5 ? "bg-amber-500/20 text-amber-400" :
              "bg-red-500/20 text-red-400"
            }`}>
              {(session.oneShotRate * 100).toFixed(0)}% 1-shot
            </span>
          )}
          {session.gitBranch && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {session.gitBranch}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {session.modelsUsed.map((m) => (
            <Badge key={m} variant="outline" className="text-[10px] px-1.5 py-0">
              {m}
            </Badge>
          ))}
        </div>
      </div>
    </Link>
  );
}

// ─── Project Group ───────────────────────────────────────────────────

interface ProjectGroup {
  projectPath: string;
  projectName: string;
  sessions: SessionSummary[];
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  totalMessages: number;
  totalErrors: number;
  totalSubagents: number;
  activeSessions: number;
  lastActivity?: string;
  modelsUsed: string[];
  topTools: [string, number][];
  avgOneShotRate?: number;
}

function buildProjectGroups(sessions: SessionSummary[]): ProjectGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.projectPath;
    const list = map.get(key) || [];
    list.push(s);
    map.set(key, list);
  }

  const groups: ProjectGroup[] = [];
  for (const [projectPath, projectSessions] of map) {
    const models = new Set<string>();
    const toolAgg: Record<string, number> = {};
    let totalTokens = 0;
    let totalCost = 0;
    let totalDurationMs = 0;
    let totalMessages = 0;
    let totalErrors = 0;
    let totalSubagents = 0;
    let activeSessions = 0;
    let lastActivity: string | undefined;

    const oneShotRates: number[] = [];
    for (const s of projectSessions) {
      totalTokens += s.inputTokens + s.outputTokens;
      totalCost += s.costEstimate;
      totalDurationMs += s.durationMs || 0;
      totalMessages += s.messageCount;
      totalErrors += s.errorCount;
      totalSubagents += s.subagentCount;
      if (s.isActive) activeSessions++;
      for (const m of s.modelsUsed) models.add(m);
      for (const [tool, count] of Object.entries(s.toolUsage)) {
        toolAgg[tool] = (toolAgg[tool] || 0) + count;
      }
      if (s.endTime && (!lastActivity || s.endTime > lastActivity)) {
        lastActivity = s.endTime;
      }
      if (s.oneShotRate !== undefined) {
        oneShotRates.push(s.oneShotRate);
      }
    }

    const avgOneShotRate =
      oneShotRates.length > 0
        ? oneShotRates.reduce((sum, r) => sum + r, 0) / oneShotRates.length
        : undefined;

    const topTools = Object.entries(toolAgg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    groups.push({
      projectPath,
      projectName: projectSessions[0].projectName,
      sessions: projectSessions,
      totalSessions: projectSessions.length,
      totalTokens,
      totalCost,
      totalDurationMs,
      totalMessages,
      totalErrors,
      totalSubagents,
      activeSessions,
      lastActivity,
      modelsUsed: Array.from(models),
      topTools,
      avgOneShotRate,
    });
  }

  // Sort groups by last activity
  groups.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  return groups;
}

function ProjectGroupCard({ group }: { group: ProjectGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border overflow-hidden">
      {/* Project summary header */}
      <button
        className="w-full text-left p-4 hover:bg-[var(--muted)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            )}
            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="font-mono text-sm truncate">{group.projectPath}</span>
            {group.activeSessions > 0 && (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            )}
          </div>
          <span className="text-xs text-[var(--muted-foreground)] shrink-0">
            {formatDate(group.lastActivity)}
          </span>
        </div>

        {/* Aggregated stats */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--muted-foreground)] ml-10">
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {group.totalSessions} session{group.totalSessions !== 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(group.totalDurationMs)}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {group.totalMessages} msgs
          </span>
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            {formatTokens(group.totalTokens)} tokens
          </span>
          <span className="flex items-center gap-1">
            <DollarSign className="h-3 w-3" />
            {formatCost(group.totalCost)}
          </span>
          {group.totalSubagents > 0 && (
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" />
              {group.totalSubagents} agents
            </span>
          )}
          {group.totalErrors > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle className="h-3 w-3" />
              {group.totalErrors} errors
            </span>
          )}
          {group.avgOneShotRate !== undefined && (
            <span className={`flex items-center gap-1 ${
              group.avgOneShotRate >= 0.8 ? "text-emerald-400" :
              group.avgOneShotRate >= 0.5 ? "text-amber-400" :
              "text-red-400"
            }`}>
              {(group.avgOneShotRate * 100).toFixed(0)}% 1-shot
            </span>
          )}
        </div>

        {/* Top tools + models */}
        <div className="mt-2 flex flex-wrap gap-1 ml-10">
          {group.topTools.map(([tool, count]) => (
            <Badge key={tool} variant="outline" className="text-[10px] px-1.5 py-0">
              {tool} ({count})
            </Badge>
          ))}
          {group.modelsUsed.map((m) => (
            <Badge key={m} variant="outline" className="text-[10px] px-1.5 py-0 border-violet-500/30 text-violet-400">
              {m}
            </Badge>
          ))}
        </div>
      </button>

      {/* Expanded session list */}
      {expanded && (
        <div className="border-t p-4 space-y-3 bg-[var(--background)]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {group.sessions.map((session) => (
              <SessionCard key={session.sessionId} session={session} showProject={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Browser ────────────────────────────────────────────────────

export function SessionsBrowser() {
  const { data, loading } = useAllSessions();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [groupByProject, setGroupByProject] = useState(false);

  const filtered = useMemo(() => {
    let result = data;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.initialPrompt?.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q) ||
          s.projectPath.toLowerCase().includes(q) ||
          s.sessionId.includes(q) ||
          s.gitBranch?.toLowerCase().includes(q)
      );
    }

    return [...result].sort((a, b) => {
      switch (sortBy) {
        case "longest":
          return (b.durationMs || 0) - (a.durationMs || 0);
        case "tokens":
          return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
        case "oneshot": {
          // Sessions without oneShotRate go to the end
          if (a.oneShotRate === undefined && b.oneShotRate === undefined) return 0;
          if (a.oneShotRate === undefined) return 1;
          if (b.oneShotRate === undefined) return -1;
          return b.oneShotRate - a.oneShotRate;
        }
        case "recent":
        default: {
          const ta = a.endTime ? new Date(a.endTime).getTime() : 0;
          const tb = b.endTime ? new Date(b.endTime).getTime() : 0;
          return tb - ta;
        }
      }
    });
  }, [data, search, sortBy]);

  const projectGroups = useMemo(
    () => (groupByProject ? buildProjectGroups(filtered) : []),
    [filtered, groupByProject]
  );

  const activeSessions = data.filter((s) => s.isActive).length;

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "recent", label: "Recent" },
    { value: "longest", label: "Longest" },
    { value: "tokens", label: "Most Tokens" },
    { value: "oneshot", label: "Best Success Rate" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Sessions</h1>
          <span className="text-sm text-[var(--muted-foreground)]">
            {data.length} total
          </span>
          {activeSessions > 0 && (
            <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-medium">
              {activeSessions} active
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
          <Input
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex gap-1">
          <Button
            variant={groupByProject ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setGroupByProject(!groupByProject)}
          >
            <FolderOpen className="h-3 w-3 mr-1" />
            Group by Project
          </Button>
          {sortOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={sortBy === opt.value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSortBy(opt.value)}
            >
              <SortAsc className="h-3 w-3 mr-1" />
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No sessions found.</p>
          {search && <p className="text-sm mt-1">Try a different search term.</p>}
        </div>
      ) : groupByProject ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted-foreground)]">
            {projectGroups.length} project{projectGroups.length !== 1 ? "s" : ""}
          </p>
          {projectGroups.map((group) => (
            <ProjectGroupCard key={group.projectPath} group={group} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((session) => (
            <SessionCard key={session.sessionId} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
