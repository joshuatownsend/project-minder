"use client";

import { useState } from "react";
import { useAllManualSteps } from "@/hooks/useManualSteps";
import { ManualStepsInfo, ManualStepEntry } from "@/lib/types";
import { useToggleStep } from "@/hooks/useManualSteps";
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ClipboardList,
} from "lucide-react";
import Link from "next/link";

type SortMode = "recent" | "pending";
type FilterMode = "all" | "pending";

function renderDetailLine(line: string) {
  const parts = line.split(/(`[^`]+`)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="bg-[var(--muted)] px-1 py-0.5 rounded text-xs font-mono"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        const urlMatch = part.match(/(https?:\/\/\S+)/);
        if (urlMatch) {
          const [before, ...rest] = part.split(urlMatch[1]);
          return (
            <span key={i}>
              {before}
              <a
                href={urlMatch[1]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline inline-flex items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                {urlMatch[1]}
                <ExternalLink className="h-3 w-3" />
              </a>
              {rest.join(urlMatch[1])}
            </span>
          );
        }
        return part;
      })}
    </span>
  );
}

function ProjectEntrySection({
  entry,
  slug,
  onUpdate,
}: {
  entry: ManualStepEntry;
  slug: string;
  onUpdate: (info: ManualStepsInfo) => void;
}) {
  const { toggle } = useToggleStep(slug);
  const completed = entry.steps.filter((s) => s.completed).length;

  return (
    <div className="space-y-1 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)] font-mono">
          {entry.date}
        </span>
        <span className="text-xs bg-[var(--muted)] px-1.5 py-0.5 rounded font-mono">
          {entry.featureSlug}
        </span>
        <span className="text-sm font-medium">{entry.title}</span>
        <span className="text-xs text-[var(--muted-foreground)] ml-auto">
          {completed}/{entry.steps.length}
        </span>
      </div>
      {entry.steps.map((step, i) => (
        <div key={i}>
          <button
            className="flex items-start gap-2 text-sm w-full text-left hover:bg-[var(--muted)] rounded px-1 py-0.5 transition-colors"
            onClick={() => toggle(step.lineNumber, onUpdate)}
          >
            {step.completed ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
            )}
            <span
              className={
                step.completed
                  ? "line-through text-[var(--muted-foreground)]"
                  : ""
              }
            >
              {step.text}
            </span>
          </button>
          {step.details.length > 0 && (
            <div className="ml-8 space-y-0.5">
              {step.details.map((detail, j) => (
                <p key={j} className="text-xs text-[var(--muted-foreground)]">
                  {renderDetailLine(detail)}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProjectSection({
  project,
  onUpdate,
}: {
  project: { slug: string; name: string; manualSteps: ManualStepsInfo };
  onUpdate: (slug: string, info: ManualStepsInfo) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-4 hover:bg-[var(--muted)] transition-colors text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" />
        )}
        <Link
          href={`/project/${project.slug}`}
          className="text-sm font-semibold hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {project.name}
        </Link>
        <span className="text-xs text-amber-400 ml-auto">
          {project.manualSteps.pendingSteps} pending
        </span>
      </button>
      {!collapsed && (
        <div className="border-t px-4 divide-y divide-[var(--border)]">
          {project.manualSteps.entries.map((entry, i) => (
            <ProjectEntrySection
              key={`${entry.featureSlug}-${i}`}
              entry={entry}
              slug={project.slug}
              onUpdate={(info) => onUpdate(project.slug, info)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ManualStepsDashboard() {
  const { data, loading, refresh } = useAllManualSteps();
  const [filter, setFilter] = useState<FilterMode>("pending");
  const [sort, setSort] = useState<SortMode>("recent");

  const handleUpdate = (slug: string, info: ManualStepsInfo) => {
    // Refresh data from server after toggle
    refresh();
  };

  const filtered = filter === "pending"
    ? data.filter((p) => p.manualSteps.pendingSteps > 0)
    : data;

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "pending") {
      return b.manualSteps.pendingSteps - a.manualSteps.pendingSteps;
    }
    // recent: compare latest entry dates
    const aDate = a.manualSteps.entries[a.manualSteps.entries.length - 1]?.date ?? "";
    const bDate = b.manualSteps.entries[b.manualSteps.entries.length - 1]?.date ?? "";
    return bDate.localeCompare(aDate);
  });

  const totalPending = data.reduce(
    (sum, p) => sum + p.manualSteps.pendingSteps,
    0
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-[var(--muted)] rounded animate-pulse" />
        <div className="h-32 bg-[var(--muted)] rounded animate-pulse" />
        <div className="h-32 bg-[var(--muted)] rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Manual Steps</h1>
          {totalPending > 0 && (
            <span className="text-sm bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium">
              {totalPending} pending
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 text-sm">
          <span className="text-[var(--muted-foreground)]">Show:</span>
          <button
            className={`px-2 py-0.5 rounded ${filter === "pending" ? "bg-[var(--muted)]" : ""}`}
            onClick={() => setFilter("pending")}
          >
            Pending
          </button>
          <button
            className={`px-2 py-0.5 rounded ${filter === "all" ? "bg-[var(--muted)]" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-[var(--muted-foreground)]">Sort:</span>
          <button
            className={`px-2 py-0.5 rounded ${sort === "recent" ? "bg-[var(--muted)]" : ""}`}
            onClick={() => setSort("recent")}
          >
            Recent
          </button>
          <button
            className={`px-2 py-0.5 rounded ${sort === "pending" ? "bg-[var(--muted)]" : ""}`}
            onClick={() => setSort("pending")}
          >
            Most Pending
          </button>
        </div>
      </div>

      {/* Project list */}
      {sorted.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <ClipboardList className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No manual steps found across your projects.</p>
          <p className="text-sm mt-1">
            Claude will create MANUAL_STEPS.md files when identifying steps you need to take.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((project) => (
            <ProjectSection
              key={project.slug}
              project={project}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
