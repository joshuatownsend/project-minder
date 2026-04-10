"use client";

import { useState, useCallback } from "react";
import { ManualStepsInfo, ManualStepEntry, ManualStep } from "@/lib/types";
import { useToggleStep } from "@/hooks/useManualSteps";
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

function renderDetailLine(line: string) {
  // Render backtick-wrapped content as code
  const parts = line.split(/(`[^`]+`)/g);
  const rendered = parts.map((part, i) => {
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
    // Detect URLs
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
  });

  return <span>{rendered}</span>;
}

function EntrySection({
  entry,
  slug,
  onUpdate,
  filter = "all",
}: {
  entry: ManualStepEntry;
  slug: string;
  onUpdate: (info: ManualStepsInfo) => void;
  filter?: FilterMode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { toggle, toggling } = useToggleStep(slug);
  // Optimistic overrides: track which lineNumbers have been toggled locally
  const [optimistic, setOptimistic] = useState<Map<number, boolean>>(new Map());

  const handleToggle = useCallback(
    (step: ManualStep) => {
      // Optimistic: flip the visual state immediately
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.set(step.lineNumber, !step.completed);
        return next;
      });

      toggle(step.lineNumber, (updated) => {
        // Server confirmed — clear the optimistic override and apply real data
        setOptimistic((prev) => {
          const next = new Map(prev);
          next.delete(step.lineNumber);
          return next;
        });
        onUpdate(updated);
      });
    },
    [toggle, onUpdate]
  );

  const resolvedSteps = entry.steps.map((step) => {
    const override = optimistic.get(step.lineNumber);
    return override !== undefined ? { ...step, completed: override } : step;
  });

  const completed = resolvedSteps.filter((s) => s.completed).length;
  const total = resolvedSteps.length;

  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        className="w-full flex items-center gap-2 p-3 hover:bg-[var(--muted)] transition-colors text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted-foreground)] font-mono">
              {entry.date}
            </span>
            <span className="text-xs bg-[var(--muted)] px-1.5 py-0.5 rounded font-mono">
              {entry.featureSlug}
            </span>
          </div>
          <p className="text-sm font-medium truncate">{entry.title}</p>
        </div>
        <span className={`text-xs shrink-0 ${toggling ? "text-amber-400" : "text-[var(--muted-foreground)]"}`}>
          {completed}/{total}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t px-3 py-2 space-y-1">
          {/* Progress bar */}
          <div className="w-full bg-[var(--muted)] rounded-full h-1.5 mb-2">
            <div
              className="bg-emerald-500 h-1.5 rounded-full transition-all"
              style={{
                width: `${total > 0 ? (completed / total) * 100 : 0}%`,
              }}
            />
          </div>

          {resolvedSteps.map((step, i) => {
            // Apply filter: skip steps that don't match
            if (filter === "open" && step.completed) return null;
            if (filter === "done" && !step.completed) return null;
            return (
            <div key={i}>
              <button
                className="flex items-start gap-2 text-sm w-full text-left hover:bg-[var(--muted)] rounded px-1 py-0.5 transition-colors"
                onClick={() => handleToggle(entry.steps[i])}
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
                    <p
                      key={j}
                      className="text-xs text-[var(--muted-foreground)]"
                    >
                      {renderDetailLine(detail)}
                    </p>
                  ))}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type FilterMode = "all" | "open" | "done";

export function ManualStepsList({
  slug,
  initialData,
}: {
  slug: string;
  initialData: ManualStepsInfo;
}) {
  const [data, setData] = useState(initialData);
  const [filter, setFilter] = useState<FilterMode>("all");

  // Filter entries: hide entries with no matching steps
  const filteredEntries = filter === "all"
    ? data.entries
    : data.entries.filter((entry) =>
        entry.steps.some((s) => (filter === "open" ? !s.completed : s.completed))
      );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Manual Steps</h3>
        <span className="text-xs text-[var(--muted-foreground)]">
          {data.completedSteps}/{data.totalSteps} completed
        </span>
      </div>

      <div className="w-full bg-[var(--muted)] rounded-full h-2">
        <div
          className="bg-emerald-500 h-2 rounded-full transition-all"
          style={{
            width: `${data.totalSteps > 0 ? (data.completedSteps / data.totalSteps) * 100 : 0}%`,
          }}
        />
      </div>

      <div className="flex items-center gap-1 text-sm">
        <span className="text-[var(--muted-foreground)] text-xs">Show:</span>
        {(["all", "open", "done"] as const).map((f) => (
          <button
            key={f}
            className={`px-2 py-0.5 rounded text-xs ${filter === f ? "bg-[var(--muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "open" ? "Open" : "Done"}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filteredEntries.length === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)] py-2">
            No {filter === "open" ? "open" : "completed"} steps.
          </p>
        ) : (
          filteredEntries.map((entry, i) => (
            <EntrySection
              key={`${entry.featureSlug}-${i}`}
              entry={entry}
              slug={slug}
              onUpdate={setData}
              filter={filter}
            />
          ))
        )}
      </div>
    </div>
  );
}
