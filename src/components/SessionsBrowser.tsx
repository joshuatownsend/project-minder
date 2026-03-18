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
} from "lucide-react";
import Link from "next/link";

type SortOption = "recent" | "longest" | "tokens";

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

function SessionCard({ session }: { session: SessionSummary }) {
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
            <span className="text-xs text-[var(--muted-foreground)] font-mono truncate">
              {session.projectName}
            </span>
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

export function SessionsBrowser() {
  const { data, loading } = useAllSessions();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");

  const filtered = useMemo(() => {
    let result = data;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.initialPrompt?.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q) ||
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
        case "recent":
        default: {
          // Sort by endTime so active/long-running sessions appear at top
          const ta = a.endTime ? new Date(a.endTime).getTime() : 0;
          const tb = b.endTime ? new Date(b.endTime).getTime() : 0;
          return tb - ta;
        }
      }
    });
  }, [data, search, sortBy]);

  const activeSessions = data.filter((s) => s.isActive).length;

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "recent", label: "Recent" },
    { value: "longest", label: "Longest" },
    { value: "tokens", label: "Most Tokens" },
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
