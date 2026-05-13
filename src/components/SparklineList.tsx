"use client";

import { useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ProjectData, SessionStatus } from "@/lib/types";
import { ActivitySparkline } from "./ActivitySparkline";
import { StatusBadge } from "./StatusBadge";
import { StatusDot } from "./ui/StatusDot";
import { DevServerControl } from "./DevServerControl";
import { Pin, PinOff } from "lucide-react";
import { pluralize } from "@/lib/utils";

type SortKey = "name" | "activity" | "lastSession" | "todos" | "branch";
type SortDir = "asc" | "desc";

// Shared column template: Pin | Project | Sparkline | Last session | Branch | Todos | Status | DevServer
const COLS = "28px minmax(160px, 1fr) 160px 90px 110px 60px 80px 110px";

const EMPTY_SPARK_DATA: number[] = new Array(14).fill(0);

function ColHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sortDir === "desc" ? "descending" : "ascending") : "none"}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-base)",
      }}
    >
      <button
        onClick={() => onSort(k)}
        style={{
          display: "block", width: "100%", textAlign: "left",
          padding: "6px 10px",
          fontSize: "0.65rem",
          fontFamily: "var(--font-mono)",
          fontWeight: active ? 600 : 500,
          color: active ? "var(--info)" : "var(--text-muted)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
          background: "none", border: "none",
        }}
      >
        {label}
        {active && (
          <span style={{ marginLeft: "3px", opacity: 0.7 }}>
            {sortDir === "desc" ? "↓" : "↑"}
          </span>
        )}
      </button>
    </div>
  );
}

interface SparklineListProps {
  projects: ProjectData[];
  activityData: Record<string, number[]>;
  pinnedSlugs: string[];
  onTogglePin: (slug: string) => void;
}

interface EnrichedProject {
  project: ProjectData;
  isPinned: boolean;
  sparkData: number[];
  pendingTodos: number;
  pendingSteps: number;
  hasAttention: boolean;
  sessionStatus: SessionStatus | undefined;
  sessionId: string | undefined;
  sessionBadge: { color: string; bg: string; border: string; label: string; title: string } | null;
  lastSession: string;
}

export function SparklineList({ projects, activityData, pinnedSlugs, onTogglePin }: SparklineListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("activity");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const router = useRouter();

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Precompute sort keys once to avoid repeated reduce/allocation inside comparator
  const sortKeys = useMemo(() => {
    const m = new Map<string, { activity: number; lastSession: string; todos: number; branch: string }>();
    for (const p of projects) {
      m.set(p.slug, {
        activity: (activityData[p.slug] ?? []).reduce((s: number, n: number) => s + n, 0),
        lastSession: p.claude?.lastSessionDate ?? "",
        todos: (p.todos?.pending ?? 0) + (p.worktrees ?? []).reduce((s, w) => s + (w.todos?.pending ?? 0), 0),
        branch: p.git?.branch ?? "",
      });
    }
    return m;
  }, [projects, activityData]);

  const sorted = useMemo(() => {
    const pinnedSet = new Set(pinnedSlugs);
    const result = [...projects].sort((a, b) => {
      const pinCmp = Number(pinnedSet.has(b.slug)) - Number(pinnedSet.has(a.slug));
      if (pinCmp !== 0) return pinCmp;

      const ak = sortKeys.get(a.slug)!;
      const bk = sortKeys.get(b.slug)!;
      let cmp = 0;
      switch (sortKey) {
        case "name":       cmp = a.name.localeCompare(b.name); break;
        case "activity":   cmp = ak.activity - bk.activity; break;
        case "lastSession": cmp = ak.lastSession.localeCompare(bk.lastSession); break;
        case "todos":      cmp = ak.todos - bk.todos; break;
        case "branch":     cmp = ak.branch.localeCompare(bk.branch); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [projects, sortKey, sortDir, pinnedSlugs, sortKeys]);

  // Memoize per-row derived values so the virtual row render is cheap
  const enrichedSorted = useMemo<EnrichedProject[]>(() => {
    const pinnedSet = new Set(pinnedSlugs);
    const now = Date.now();
    return sorted.map((project) => {
      const isPinned = pinnedSet.has(project.slug);
      const sparkData = activityData[project.slug] ?? EMPTY_SPARK_DATA;
      const pendingTodos =
        (project.todos?.pending ?? 0) +
        (project.worktrees ?? []).reduce((s, w) => s + (w.todos?.pending ?? 0), 0);
      const pendingSteps =
        (project.manualSteps?.pendingSteps ?? 0) +
        (project.worktrees ?? []).reduce((s, w) => s + (w.manualSteps?.pendingSteps ?? 0), 0);
      const hasAttention = pendingTodos > 0 || pendingSteps > 0;
      const sessionStatus = project.claude?.mostRecentSessionStatus;
      const sessionId = project.claude?.mostRecentSessionId;
      const sessionBadge =
        sessionStatus && sessionStatus !== "idle"
          ? sessionStatus === "working"
            ? { color: "var(--status-active-text)", bg: "var(--status-active-bg)", border: "var(--status-active-border)", label: "coding", title: "Claude is coding" }
            : { color: "var(--accent)", bg: "var(--accent-bg)", border: "var(--accent-border)", label: "waiting", title: "Claude is waiting for you" }
          : null;
      const lastSession = project.claude?.lastSessionDate
        ? (() => {
            const d = new Date(project.claude!.lastSessionDate!);
            const diffDays = Math.floor((now - d.getTime()) / 86_400_000);
            if (diffDays < 1) return "today";
            if (diffDays === 1) return "yesterday";
            if (diffDays < 7) return `${diffDays}d ago`;
            if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
            return `${Math.floor(diffDays / 30)}mo ago`;
          })()
        : "—";
      return { project, isPinned, sparkData, pendingTodos, pendingSteps, hasAttention, sessionStatus, sessionId, sessionBadge, lastSession };
    });
  }, [sorted, activityData, pinnedSlugs]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: enrichedSorted.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 50,
    overscan: 8,
    getItemKey: (index) => enrichedSorted[index].project.slug,
  });

  const headerCell = (): React.CSSProperties => ({
    padding: "6px 10px",
    borderBottom: "1px solid var(--border-subtle)",
    background: "var(--bg-base)",
    fontSize: "0.65rem",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  });

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <div role="grid" aria-label="Projects" style={{ minWidth: "840px" }}>
        {/* Sticky header row */}
        <div role="rowgroup">
          <div
            role="row"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <div role="columnheader" style={headerCell()}><span className="sr-only">Pin</span></div>
            <ColHeader label="Project"         k="name"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <ColHeader label="14-day activity" k="activity"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <ColHeader label="Last session"    k="lastSession" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <ColHeader label="Branch"          k="branch"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <ColHeader label="Todos"           k="todos"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <div role="columnheader" style={headerCell()}><span className="sr-only">Status</span></div>
            <div role="columnheader" style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-base)" }}><span className="sr-only">Dev server</span></div>
          </div>
        </div>

        {/* Virtual body */}
        <div
          ref={scrollContainerRef}
          role="rowgroup"
          style={{ height: "calc(100vh - 220px)", minHeight: "300px", overflowY: "auto" }}
        >
          {enrichedSorted.length === 0 ? (
            <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
              No projects match.
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
              {virtualizer.getVirtualItems().map((vItem) => {
                const { project, isPinned, sparkData, pendingTodos, pendingSteps, hasAttention, sessionStatus, sessionId, sessionBadge, lastSession } = enrichedSorted[vItem.index];
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    role="row"
                    onClick={() => router.push(`/project/${project.slug}`)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/project/${project.slug}`); } }}
                    tabIndex={0}
                    aria-label={`Open ${project.name}`}
                    className="sparkline-row"
                    style={{
                      display: "grid",
                      gridTemplateColumns: COLS,
                      alignItems: "center",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                      cursor: "pointer",
                      borderBottom: "1px solid var(--border-subtle)",
                      opacity: project.status === "archived" ? 0.5 : 1,
                      transition: "background 0.1s",
                      background: isPinned ? "var(--info-bg)" : undefined,
                    }}
                  >
                    {/* Pin */}
                    <div
                      role="gridcell"
                      style={{ padding: "4px 4px 4px 10px" }}
                      onClick={(e) => { e.stopPropagation(); onTogglePin(project.slug); }}
                    >
                      <button
                        title={isPinned ? "Unpin" : "Pin to top"}
                        aria-label={isPinned ? `Unpin ${project.name}` : `Pin ${project.name} to top`}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: "20px", height: "20px", padding: 0,
                          background: "none", border: "none", cursor: "pointer",
                          color: isPinned ? "var(--info)" : "var(--text-muted)",
                          opacity: isPinned ? 1 : 0.55,
                          transition: "opacity 0.1s, color 0.1s",
                        }}
                        className="pin-btn"
                      >
                        {isPinned
                          ? <PinOff style={{ width: "11px", height: "11px" }} />
                          : <Pin style={{ width: "11px", height: "11px" }} />
                        }
                      </button>
                    </div>

                    {/* Name */}
                    <div role="gridcell" style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{
                          fontFamily: "var(--font-body)", fontSize: "0.8rem", fontWeight: 500,
                          color: "var(--text-primary)", whiteSpace: "nowrap",
                        }}>
                          {project.name}
                        </span>
                        {sessionBadge && (
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(sessionId ? `/sessions/${sessionId}` : "/sessions"); }}
                            title={sessionBadge.title}
                            aria-label={`${sessionBadge.title} — view session`}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: "3px",
                              fontSize: "0.65rem", fontFamily: "var(--font-mono)",
                              color: sessionBadge.color, background: sessionBadge.bg,
                              border: `1px solid ${sessionBadge.border}`,
                              borderRadius: "3px", padding: "1px 5px", cursor: "pointer",
                            }}
                          >
                            <StatusDot status={sessionStatus} size={5} />
                            {sessionBadge.label}
                          </button>
                        )}
                        {hasAttention && (
                          <span
                            title={`${pluralize(pendingTodos, "todo")}${pendingSteps > 0 ? ` + ${pluralize(pendingSteps, "manual step")}` : ""} pending`}
                            style={{ fontSize: "0.6rem", color: "var(--accent)", fontFamily: "var(--font-mono)", cursor: "default" }}
                          >
                            {pendingTodos + pendingSteps}▲
                          </span>
                        )}
                      </div>
                      {project.framework && (
                        <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: "2px" }}>
                          {project.framework}{project.frameworkVersion ? ` ${project.frameworkVersion}` : ""}
                        </div>
                      )}
                    </div>

                    {/* Sparkline */}
                    <div role="gridcell" style={{ padding: "8px 10px" }}>
                      <ActivitySparkline data={sparkData} />
                    </div>

                    {/* Last session */}
                    <div role="gridcell" style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                        {lastSession}
                      </span>
                    </div>

                    {/* Branch */}
                    <div role="gridcell" style={{ padding: "8px 10px" }}>
                      {project.git ? (
                        <span style={{
                          fontSize: "0.68rem", fontFamily: "var(--font-mono)",
                          color: project.git.isDirty ? "var(--accent)" : "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}>
                          {project.git.branch}
                          {project.git.uncommittedCount > 0 && (
                            <span style={{ marginLeft: "4px", color: "var(--accent)" }}>
                              +{project.git.uncommittedCount}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>—</span>
                      )}
                    </div>

                    {/* Todos */}
                    <div role="gridcell" style={{ padding: "8px 10px" }}>
                      <span style={{
                        fontSize: "0.72rem", fontFamily: "var(--font-mono)",
                        color: pendingTodos > 0 ? "var(--accent)" : "var(--text-muted)",
                      }}>
                        {pendingTodos > 0 ? pendingTodos : "—"}
                      </span>
                    </div>

                    {/* Status */}
                    <div role="gridcell" style={{ padding: "8px 10px" }}>
                      <StatusBadge status={project.status} />
                    </div>

                    {/* Dev server */}
                    <div
                      role="gridcell"
                      style={{ padding: "8px 10px" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DevServerControl
                        slug={project.slug}
                        projectPath={project.path}
                        devPort={project.devPort}
                        compact
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .sparkline-row:hover { background: var(--muted) !important; }
        .sparkline-row:hover .pin-btn { opacity: 1 !important; }
      `}</style>
    </div>
  );
}
