"use client";

import { useState, useEffect, useMemo } from "react";
import { SessionSummary } from "@/lib/types";
import { StatCard } from "./stats/StatCard";
import { BarChart } from "./stats/BarChart";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import {
  Clock,
  Cpu,
  MessageSquare,
  GitBranch,
  Bot,
  Wrench,
  AlertCircle,
  DollarSign,
  Layers,
} from "lucide-react";
import Link from "next/link";

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

export function ProjectSessions({ projectPath }: { projectPath: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch all sessions then filter client-side by projectPath
    fetch("/api/sessions")
      .then((res) => res.json())
      .then((all: SessionSummary[]) => {
        const filtered = all.filter((s) => s.projectPath === projectPath);
        setSessions(filtered);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectPath]);

  const stats = useMemo(() => {
    if (sessions.length === 0) return null;
    const totalTokens = sessions.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    const totalCost = sessions.reduce((s, x) => s + x.costEstimate, 0);
    const totalDuration = sessions.reduce((s, x) => s + (x.durationMs || 0), 0);
    const totalMessages = sessions.reduce((s, x) => s + x.messageCount, 0);
    const totalErrors = sessions.reduce((s, x) => s + x.errorCount, 0);
    const totalSubagents = sessions.reduce((s, x) => s + x.subagentCount, 0);
    const models = new Set<string>();
    const toolAgg: Record<string, number> = {};
    for (const s of sessions) {
      for (const m of s.modelsUsed) models.add(m);
      for (const [tool, count] of Object.entries(s.toolUsage)) {
        toolAgg[tool] = (toolAgg[tool] || 0) + count;
      }
    }
    return {
      totalTokens,
      totalCost,
      totalDuration,
      totalMessages,
      totalErrors,
      totalSubagents,
      modelsUsed: Array.from(models),
      toolUsage: toolAgg,
    };
  }, [sessions]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="text-[var(--muted-foreground)] text-center py-8">
        No Claude Code sessions found for this project.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Aggregated stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          label="Sessions"
          value={sessions.length}
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard
          label="Total Time"
          value={formatDuration(stats!.totalDuration)}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatCard
          label="Messages"
          value={stats!.totalMessages}
          icon={<MessageSquare className="h-4 w-4" />}
        />
        <StatCard
          label="Tokens"
          value={formatTokens(stats!.totalTokens)}
          icon={<Cpu className="h-4 w-4" />}
        />
        <StatCard
          label="Cost"
          value={formatCost(stats!.totalCost)}
          icon={<DollarSign className="h-4 w-4" />}
        />
        <StatCard
          label="Errors"
          value={stats!.totalErrors}
          icon={<AlertCircle className="h-4 w-4" />}
        />
      </div>

      {/* Tool usage + models */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Tool Usage
          </h3>
          <BarChart data={stats!.toolUsage} colorClass="bg-violet-500" />
        </div>
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium">Models Used</h3>
          <div className="flex flex-wrap gap-2">
            {stats!.modelsUsed.map((m) => (
              <Badge key={m} variant="outline">{m}</Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Session list */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">All Sessions</h3>
        <div className="space-y-2">
          {sessions.map((session) => {
            const totalTools = Object.values(session.toolUsage).reduce((s, c) => s + c, 0);
            return (
              <Link key={session.sessionId} href={`/sessions/${session.sessionId}`}>
                <div className="rounded-lg border p-3 hover:bg-[var(--muted)] transition-colors cursor-pointer">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {session.isActive && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                          </span>
                        )}
                        {session.initialPrompt ? (
                          <p className="text-sm truncate">{session.initialPrompt}</p>
                        ) : (
                          <p className="text-sm text-[var(--muted-foreground)] italic">No prompt</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)] mt-1">
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
                        {session.gitBranch && (
                          <span className="flex items-center gap-1">
                            <GitBranch className="h-3 w-3" />
                            {session.gitBranch}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                      {formatDate(session.endTime)}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
