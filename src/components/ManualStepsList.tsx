"use client";

import { useState, useCallback } from "react";
import { ManualStepsInfo, ManualStepEntry, ManualStep, WorktreeOverlay } from "@/lib/types";
import { useToggleStep } from "@/hooks/useManualSteps";
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { WorktreeSection } from "./WorktreeSection";

type FilterMode = "open" | "all" | "done";

// ── Detail line renderer ───────────────────────────────────────────────────────
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

// ── Entry section ──────────────────────────────────────────────────────────────
function EntrySection({
  entry,
  slug,
  filter,
  onUpdate,
}: {
  entry: ManualStepEntry;
  slug: string;
  filter: FilterMode;
  onUpdate: (info: ManualStepsInfo) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
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

  const visibleSteps = resolvedSteps.filter((s) => {
    if (filter === "open") return !s.completed;
    if (filter === "done") return s.completed;
    return true;
  });

  const pendingCount = resolvedSteps.filter((s) => !s.completed).length;
  const totalCount = resolvedSteps.length;

  if (visibleSteps.length === 0) return null;

  return (
    <div>
      {/* Entry header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: "4px 0",
          cursor: "pointer",
          flexWrap: "wrap",
        }}
      >
        {collapsed ? (
          <ChevronRight style={{ width: "11px", height: "11px", color: "var(--text-muted)", flexShrink: 0 }} />
        ) : (
          <ChevronDown style={{ width: "11px", height: "11px", color: "var(--text-muted)", flexShrink: 0 }} />
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {entry.date}
        </span>
        {entry.featureSlug && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-secondary)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "3px",
              padding: "1px 4px",
              flexShrink: 0,
            }}
          >
            {entry.featureSlug}
          </span>
        )}
        <span
          style={{
            fontSize: "0.75rem",
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
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: pendingCount > 0 ? "var(--accent)" : "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {totalCount - pendingCount}/{totalCount}
        </span>
      </button>

      {/* Progress bar */}
      {!collapsed && (
        <div
          style={{
            margin: "4px 0 6px 19px",
            height: "2px",
            background: "var(--border-subtle)",
            borderRadius: "1px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              background: "var(--status-active-text)",
              borderRadius: "1px",
              width: "100%",
              transform: `scaleX(${totalCount > 0 ? (totalCount - pendingCount) / totalCount : 0})`,
              transformOrigin: "left",
              transition: "transform 0.2s ease",
            }}
          />
        </div>
      )}

      {/* Steps */}
      {!collapsed && (
        <div style={{ paddingLeft: "19px", display: "flex", flexDirection: "column", gap: "1px", paddingBottom: "10px" }}>
          {visibleSteps.map((step) => {
            const originalStep = entry.steps.find((s) => s.lineNumber === step.lineNumber)!;
            return (
              <div key={step.lineNumber}>
                <button
                  onClick={() => handleToggle(originalStep)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "7px",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "3px 5px",
                    borderRadius: "3px",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLElement).style.background = "transparent")
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
                      fontSize: "0.78rem",
                      lineHeight: 1.45,
                      color: step.completed ? "var(--text-muted)" : "var(--text-primary)",
                      textDecoration: step.completed ? "line-through" : "none",
                    }}
                  >
                    {step.text}
                  </span>
                </button>
                {step.details.length > 0 && (
                  <div
                    style={{
                      paddingLeft: "25px",
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
                          fontSize: "0.7rem",
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
      )}
    </div>
  );
}

// ── Main per-project list ──────────────────────────────────────────────────────
export function ManualStepsList({
  slug,
  initialData,
  worktrees,
}: {
  slug: string;
  initialData: ManualStepsInfo;
  worktrees?: WorktreeOverlay[];
}) {
  const [data, setData] = useState(initialData);
  const [filter, setFilter] = useState<FilterMode>("open");

  const filteredEntries = data.entries.filter((entry) =>
    filter === "all"
      ? true
      : entry.steps.some((s) => (filter === "open" ? !s.completed : s.completed))
  );

  const filterOptions: { value: FilterMode; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "all", label: "All" },
    { value: "done", label: "Done" },
  ];

  const pendingCount = data.pendingSteps;
  const totalCount = data.totalSteps;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: pendingCount > 0 ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {totalCount - pendingCount}/{totalCount} complete
        </span>

        <div style={{ flex: 1 }} />

        {/* Filter toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              style={{
                padding: "4px 10px",
                fontSize: "0.68rem",
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
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: "2px",
          background: "var(--border-subtle)",
          borderRadius: "1px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            background: "var(--status-active-text)",
            borderRadius: "1px",
            width: "100%",
            transform: `scaleX(${totalCount > 0 ? (totalCount - pendingCount) / totalCount : 0})`,
            transformOrigin: "left",
            transition: "transform 0.2s ease",
          }}
        />
      </div>

      {/* Entries */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {filteredEntries.length === 0 ? (
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", padding: "8px 0" }}>
            No {filter === "open" ? "open " : filter === "done" ? "completed " : ""}steps.
          </p>
        ) : (
          filteredEntries.map((entry, i) => (
            <EntrySection
              key={`${entry.featureSlug}-${i}`}
              entry={entry}
              slug={slug}
              filter={filter}
              onUpdate={setData}
            />
          ))
        )}
      </div>

      {/* Worktree sections */}
      {worktrees?.map((wt) =>
        wt.manualSteps && wt.manualSteps.totalSteps > 0 ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.manualSteps.totalSteps}
            itemLabel={wt.manualSteps.totalSteps === 1 ? "step" : "steps"}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              {wt.manualSteps.entries
                .filter((entry) =>
                  filter === "all"
                    ? true
                    : entry.steps.some((s) =>
                        filter === "open" ? !s.completed : s.completed
                      )
                )
                .map((entry, i) => (
                  <div key={i} style={{ paddingBottom: "12px" }}>
                    {/* Entry metadata */}
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
                          fontSize: "0.65rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        {entry.date}
                      </span>
                      {entry.featureSlug && (
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.65rem",
                            color: "var(--text-secondary)",
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "3px",
                            padding: "1px 4px",
                          }}
                        >
                          {entry.featureSlug}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 500,
                          color: "var(--text-primary)",
                        }}
                      >
                        {entry.title}
                      </span>
                    </div>
                    {/* Steps (read-only — worktree steps can't be toggled from parent context) */}
                    <div style={{ paddingLeft: "4px", display: "flex", flexDirection: "column", gap: "2px" }}>
                      {entry.steps
                        .filter((s) => {
                          if (filter === "open") return !s.completed;
                          if (filter === "done") return s.completed;
                          return true;
                        })
                        .map((step, j) => (
                          <div
                            key={j}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "7px",
                              padding: "2px 5px",
                            }}
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
                                fontSize: "0.78rem",
                                lineHeight: 1.45,
                                color: step.completed
                                  ? "var(--text-muted)"
                                  : "var(--text-primary)",
                                textDecoration: step.completed
                                  ? "line-through"
                                  : "none",
                              }}
                            >
                              {step.text}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          </WorktreeSection>
        ) : null
      )}
    </div>
  );
}
