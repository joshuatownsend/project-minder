"use client";

import { useState, useMemo, useEffect } from "react";
import { useAllInsights } from "@/hooks/useInsights";
import { InsightEntry } from "@/lib/types";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Lightbulb, Search } from "lucide-react";
import Link from "next/link";

function formatDate(iso: string): string {
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

function InsightCard({ insight }: { insight: InsightEntry }) {
  return (
    <div className="rounded-lg border bg-[var(--card)] p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/project/${insight.project}`}
          className="text-xs font-mono text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors truncate"
        >
          {insight.project}
        </Link>
        <span className="text-xs text-[var(--muted-foreground)] shrink-0">
          {formatDate(insight.date)}
        </span>
      </div>

      <p className="text-sm whitespace-pre-wrap leading-relaxed">{insight.content}</p>

      <div className="flex items-center justify-between">
        <Link
          href={`/sessions/${insight.sessionId}`}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors font-mono truncate"
        >
          session: {insight.sessionId.slice(0, 12)}…
        </Link>
      </div>
    </div>
  );
}

export function InsightsBrowser() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");

  // 300ms debounce on search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading } = useAllInsights(projectFilter || undefined, debouncedSearch || undefined);

  const projects = useMemo(() => {
    const seen = new Set<string>();
    for (const insight of data.insights) {
      seen.add(insight.project);
    }
    return Array.from(seen).sort();
  }, [data.insights]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Lightbulb className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Insights</h1>
        <span className="text-sm text-[var(--muted-foreground)]">
          {data.total} total
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
          <Input
            placeholder="Search insights..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-md border bg-[var(--card)] px-3 py-2 text-sm"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      ) : data.insights.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <Lightbulb className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No insights found.</p>
          {(search || projectFilter) && (
            <p className="text-sm mt-1">Try a different search term or project filter.</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
}
