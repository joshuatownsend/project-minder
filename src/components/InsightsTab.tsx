"use client";

import { useState } from "react";
import { useProjectInsights } from "@/hooks/useInsights";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Search, Lightbulb, Calendar } from "lucide-react";
import Link from "next/link";
import { WorktreeOverlay } from "@/lib/types";
import { WorktreeSection } from "./WorktreeSection";

interface InsightsTabProps {
  slug: string;
  worktrees?: WorktreeOverlay[];
}

export function InsightsTab({ slug, worktrees }: InsightsTabProps) {
  const { data, loading } = useProjectInsights(slug);
  const [query, setQuery] = useState("");

  const filtered = data?.entries.filter((e) =>
    e.content.toLowerCase().includes(query.toLowerCase())
  ) ?? [];

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
        <Input
          placeholder="Filter insights…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-[var(--muted-foreground)] space-y-2">
          <Lightbulb className="mx-auto h-8 w-8 opacity-30" />
          <p className="text-sm">
            {query ? "No insights match your filter." : "No insights recorded for this project yet."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((insight) => (
            <li
              key={insight.id}
              className="rounded-lg border p-4 space-y-2 hover:border-[var(--ring)] transition-colors"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted-foreground)]">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {(() => {
                    const d = new Date(insight.date);
                    return isFinite(d.getTime())
                      ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                      : "—";
                  })()}
                </span>
                <Link
                  href={`/sessions/${insight.sessionId}`}
                  className="flex items-center gap-1 hover:text-[var(--foreground)] transition-colors"
                >
                  <Lightbulb className="h-3 w-3" />
                  View session
                </Link>
              </div>
              <p className="text-sm leading-relaxed">{insight.content}</p>
            </li>
          ))}
        </ul>
      )}

      {data && data.total > 0 && (
        <p className="text-xs text-[var(--muted-foreground)] text-right">
          {filtered.length === data.total
            ? `${data.total} insight${data.total !== 1 ? "s" : ""}`
            : `${filtered.length} of ${data.total} insights`}
        </p>
      )}

      {worktrees?.map((wt) =>
        wt.insights && wt.insights.total > 0 ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.insights.total}
            itemLabel={wt.insights.total === 1 ? "insight" : "insights"}
          >
            <ul className="space-y-3">
              {wt.insights.entries
                .filter((e) =>
                  e.content.toLowerCase().includes(query.toLowerCase())
                )
                .map((insight) => (
                  <li
                    key={insight.id}
                    className="rounded-lg border p-4 space-y-2"
                  >
                    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {(() => {
                          const d = new Date(insight.date);
                          return isFinite(d.getTime())
                            ? d.toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })
                            : "—";
                        })()}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{insight.content}</p>
                  </li>
                ))}
            </ul>
          </WorktreeSection>
        ) : null
      )}
    </div>
  );
}
