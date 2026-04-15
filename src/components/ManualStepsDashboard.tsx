"use client";

import { useState, useCallback } from "react";
import { useAllManualSteps } from "@/hooks/useManualSteps";
import { ManualStepsInfo, ManualStepEntry, ManualStep } from "@/lib/types";
import { useToggleStep } from "@/hooks/useManualSteps";
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ClipboardList,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";

type SortMode = "recent" | "pending";
type FilterMode = "pending" | "all";

// ── Detail line renderer (backtick code + URL links) ──────────────────────────
function renderDetailLine(line: string) {
  const parts = line.split(/(`[^`]+`)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px",
                padding: "1px 4px",
                color: "var(--text-secondary)",
              }}
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
                style={{
                  color: "var(--accent)",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "2px",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {urlMatch[1]}
                <ExternalLink style={{ width: "10px", height: "10px" }} />
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

// ── Single entry block (date / slug / title + steps) ─────────────────────────
function EntryBlock({
  entry,
  slug,
  showCompleted,
  onUpdate,
}: {
  entry: ManualStepEntry;
  slug: string;
  showCompleted: boolean;
  onUpdate: (info: ManualStepsInfo) => void;
}) {
  const { toggle } = useToggleStep(slug);
  const [optimistic, setOptimistic] = useState<Map<number, boolean>>(new Map());

  const handleToggle = useCallback(
    (step: ManualStep) => {
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.set(step.lineNumber, !step.completed);
        return next;
      });
      toggle(step.lineNumber, (updated) => {
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

  const visibleSteps = showCompleted
    ? resolvedSteps
    : resolvedSteps.filter((s) => !s.completed);

  const pendingCount = resolvedSteps.filter((s) => !s.completed).length;

  // If all steps are done and we're hiding completed, skip this entry
  if (!showCompleted && pendingCount === 0) return null;

  return (
    <div style={{ paddingBottom: "14px" }}>
      {/* Entry metadata row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "6px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.68rem",
            color: "var(--text-muted)",
            letterSpacing: "0.01em",
            flexShrink: 0,
          }}
        >
          {entry.date}
        </span>
        {entry.featureSlug && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              color: "var(--text-secondary)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "3px",
              padding: "1px 5px",
              flexShrink: 0,
            }}
          >
            {entry.featureSlug}
          </span>
        )}
        <span
          style={{
            fontSize: "0.78rem",
            fontWeight: 500,
            color: "var(--text-primary)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.title}
        </span>
        {pendingCount > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            {pendingCount} left
          </span>
        )}
      </div>

      {/* Steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        {visibleSteps.map((step, i) => {
          const originalStep = entry.steps.find(
            (s) => s.lineNumber === step.lineNumber
          )!;
          return (
            <div key={step.lineNumber}>
              <button
                onClick={() => handleToggle(originalStep)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "3px 6px",
                  borderRadius: "3px",
                  cursor: "pointer",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background =
                    "var(--bg-elevated)")
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background =
                    "transparent")
                }
              >
                {step.completed ? (
                  <CheckCircle2
                    style={{
                      width: "13px",
                      height: "13px",
                      color: "var(--status-active-text)",
                      flexShrink: 0,
                      marginTop: "2px",
                    }}
                  />
                ) : (
                  <Circle
                    style={{
                      width: "13px",
                      height: "13px",
                      color: "var(--text-muted)",
                      flexShrink: 0,
                      marginTop: "2px",
                    }}
                  />
                )}
                <span
                  style={{
                    fontSize: "0.8rem",
                    lineHeight: 1.45,
                    color: step.completed
                      ? "var(--text-muted)"
                      : "var(--text-primary)",
                    textDecoration: step.completed ? "line-through" : "none",
                  }}
                >
                  {step.text}
                </span>
              </button>
              {step.details.length > 0 && (
                <div
                  style={{
                    paddingLeft: "27px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                    marginBottom: "2px",
                  }}
                >
                  {step.details.map((detail, j) => (
                    <p
                      key={j}
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--text-muted)",
                        lineHeight: 1.4,
                        margin: 0,
                      }}
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
    </div>
  );
}

// ── Project section (collapsible) ─────────────────────────────────────────────
function ProjectSection({
  project,
  showCompleted,
  collapsed,
  onToggle,
  onUpdate,
}: {
  project: { slug: string; name: string; manualSteps: ManualStepsInfo };
  showCompleted: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onUpdate: (slug: string, info: ManualStepsInfo) => void;
}) {

  const { manualSteps } = project;
  const visibleEntries = showCompleted
    ? manualSteps.entries
    : manualSteps.entries.filter((e) => e.steps.some((s) => !s.completed));

  const pendingCount = manualSteps.pendingSteps;

  return (
    <div>
      {/* Project header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          paddingBottom: "10px",
          marginBottom: collapsed ? 0 : "2px",
        }}
      >
        <button
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "16px",
            height: "16px",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {collapsed ? (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          )}
        </button>

        <Link
          href={`/project/${project.slug}`}
          style={{
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            textDecoration: "none",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {project.name}
        </Link>

        {pendingCount > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              fontWeight: 500,
              color: "var(--accent)",
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-border)",
              borderRadius: "3px",
              padding: "1px 5px",
            }}
          >
            {pendingCount} pending
          </span>
        )}

        {/* Rule to the right */}
        <div
          style={{
            flex: 1,
            height: "1px",
            background: "var(--border-subtle)",
          }}
        />
      </div>

      {/* Entries */}
      {!collapsed && (
        <div style={{ paddingLeft: "26px" }}>
          {visibleEntries.length === 0 ? (
            <p
              style={{
                fontSize: "0.72rem",
                color: "var(--text-muted)",
                padding: "4px 0 14px",
              }}
            >
              All steps complete.
            </p>
          ) : (
            visibleEntries.map((entry, i) => (
              <EntryBlock
                key={`${entry.featureSlug}-${i}`}
                entry={entry}
                slug={project.slug}
                showCompleted={showCompleted}
                onUpdate={(info) => onUpdate(project.slug, info)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Main dashboard ─────────────────────────────────────────────────────────────
export function ManualStepsDashboard() {
  const { data, loading, refresh } = useAllManualSteps();
  const [filter, setFilter] = useState<FilterMode>("pending");
  const [sort, setSort] = useState<SortMode>("recent");
  const [showCompleted, setShowCompleted] = useState(false);
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(new Set());

  const handleUpdate = (_slug: string, _info: ManualStepsInfo) => {
    refresh();
  };

  const toggleCollapse = (slug: string) => {
    setCollapsedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  // Filter projects
  const filtered =
    filter === "pending"
      ? data.filter((p) => p.manualSteps.pendingSteps > 0)
      : data;

  // Sort projects
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "pending") {
      return b.manualSteps.pendingSteps - a.manualSteps.pendingSteps;
    }
    // recent: latest entry date
    const aDate =
      a.manualSteps.entries[a.manualSteps.entries.length - 1]?.date ?? "";
    const bDate =
      b.manualSteps.entries[b.manualSteps.entries.length - 1]?.date ?? "";
    return bDate.localeCompare(aDate);
  });

  const totalPending = data.reduce(
    (sum, p) => sum + p.manualSteps.pendingSteps,
    0
  );

  const allCollapsed = sorted.length > 0 && sorted.every((p) => collapsedSlugs.has(p.slug));

  const collapseAll = () =>
    setCollapsedSlugs(new Set(sorted.map((p) => p.slug)));
  const expandAll = () =>
    setCollapsedSlugs(new Set());

  const filterOptions: { value: FilterMode; label: string }[] = [
    { value: "pending", label: "Pending" },
    { value: "all", label: "All projects" },
  ];

  const sortOptions: { value: SortMode; label: string }[] = [
    { value: "recent", label: "Recent" },
    { value: "pending", label: "Most pending" },
  ];

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: "80px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <ClipboardList
          style={{ width: "14px", height: "14px", color: "var(--text-muted)" }}
        />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}
        >
          Manual Steps
        </h1>
        {totalPending > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              fontWeight: 500,
              color: "var(--accent)",
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-border)",
              borderRadius: "3px",
              padding: "2px 6px",
            }}
          >
            {totalPending} pending
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={refresh}
          title="Refresh"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "26px",
            height: "26px",
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: "3px",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <RefreshCw style={{ width: "11px", height: "11px" }} />
        </button>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {/* Filter */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem",
                fontWeight: filter === opt.value ? 600 : 400,
                fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color:
                  filter === opt.value
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                background:
                  filter === opt.value ? "var(--bg-elevated)" : "transparent",
                border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
                lineHeight: 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem",
                fontWeight: sort === opt.value ? 600 : 400,
                fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color:
                  sort === opt.value
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                background:
                  sort === opt.value ? "var(--bg-elevated)" : "transparent",
                border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
                lineHeight: 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Show completed toggle */}
        <button
          onClick={() => setShowCompleted((v) => !v)}
          style={{
            padding: "5px 11px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-body)",
            letterSpacing: "0.03em",
            color: showCompleted ? "var(--status-active-text)" : "var(--text-secondary)",
            background: showCompleted ? "var(--status-active-bg)" : "var(--bg-surface)",
            border: `1px solid ${showCompleted ? "var(--status-active-border)" : "var(--border-subtle)"}`,
            borderRadius: "var(--radius)",
            cursor: "pointer",
            transition: "background 0.1s, color 0.1s, border-color 0.1s",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {showCompleted ? "Hide done" : "Show done"}
        </button>

        {/* Collapse / expand all */}
        {sorted.length > 0 && (
          <button
            onClick={allCollapsed ? expandAll : collapseAll}
            style={{
              padding: "5px 11px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              letterSpacing: "0.03em",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              transition: "color 0.1s",
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {/* ── Meta row ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          marginTop: "-8px",
        }}
      >
        {sorted.length} project{sorted.length !== 1 ? "s" : ""}
      </div>

      {/* ── Project list ─────────────────────────────────────────────────────── */}
      {sorted.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <ClipboardList
            style={{ width: "28px", height: "28px", color: "var(--text-muted)", opacity: 0.4 }}
          />
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {filter === "pending"
              ? "No pending steps across your projects."
              : "No manual steps found across your projects."}
          </p>
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", opacity: 0.6 }}>
            Claude appends to MANUAL_STEPS.md when it identifies steps you need to take.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {sorted.map((project) => (
            <ProjectSection
              key={project.slug}
              project={project}
              showCompleted={showCompleted}
              collapsed={collapsedSlugs.has(project.slug)}
              onToggle={() => toggleCollapse(project.slug)}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
