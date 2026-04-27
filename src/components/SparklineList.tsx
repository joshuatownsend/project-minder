"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectData } from "@/lib/types";
import { ActivitySparkline } from "./ActivitySparkline";
import { StatusBadge } from "./StatusBadge";
import { StatusDot } from "./ui/StatusDot";
import { DevServerControl } from "./DevServerControl";
import { Pin, PinOff } from "lucide-react";
import { pluralize } from "@/lib/utils";

type SortKey = "name" | "activity" | "lastSession" | "todos" | "branch";
type SortDir = "asc" | "desc";

interface SparklineListProps {
  projects: ProjectData[];
  activityData: Record<string, number[]>;
  pinnedSlugs: string[];
  onTogglePin: (slug: string) => void;
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

  const sorted = [...projects].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "activity": {
        const aSum = (activityData[a.slug] ?? new Array(14).fill(0)).reduce((s: number, n: number) => s + n, 0);
        const bSum = (activityData[b.slug] ?? new Array(14).fill(0)).reduce((s: number, n: number) => s + n, 0);
        cmp = aSum - bSum;
        break;
      }
      case "lastSession": {
        const aT = a.claude?.lastSessionDate ?? "";
        const bT = b.claude?.lastSessionDate ?? "";
        cmp = aT.localeCompare(bT);
        break;
      }
      case "todos": {
        const aTodos = (a.todos?.pending ?? 0) + (a.worktrees ?? []).reduce((s, w) => s + (w.todos?.pending ?? 0), 0);
        const bTodos = (b.todos?.pending ?? 0) + (b.worktrees ?? []).reduce((s, w) => s + (w.todos?.pending ?? 0), 0);
        cmp = aTodos - bTodos;
        break;
      }
      case "branch":
        cmp = (a.git?.branch ?? "").localeCompare(b.git?.branch ?? "");
        break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const ColHeader = ({ label, k }: { label: string; k: SortKey }) => {
    const active = sortKey === k;
    return (
      <th
        scope="col"
        onClick={() => toggleSort(k)}
        style={{
          padding: "6px 10px",
          textAlign: "left",
          fontSize: "0.65rem",
          fontFamily: "var(--font-mono)",
          fontWeight: active ? 600 : 500,
          color: active ? "var(--info)" : "var(--text-muted)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-base)",
        }}
      >
        {label}
        {active && (
          <span style={{ marginLeft: "3px", opacity: 0.7 }}>
            {sortDir === "desc" ? "↓" : "↑"}
          </span>
        )}
      </th>
    );
  };

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th scope="col" style={{ width: "28px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-base)", padding: "6px 4px 6px 10px", fontSize: "0.65rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Pin</th>
            <ColHeader label="Project" k="name" />
            <ColHeader label="14-day activity" k="activity" />
            <ColHeader label="Last session" k="lastSession" />
            <ColHeader label="Branch" k="branch" />
            <ColHeader label="Todos" k="todos" />
            <th
              scope="col"
              style={{
                padding: "6px 10px",
                textAlign: "left",
                fontSize: "0.65rem",
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                borderBottom: "1px solid var(--border-subtle)",
                background: "var(--bg-base)",
              }}
            >
              Status
            </th>
            <th scope="col" style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-base)" }} />
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td
                colSpan={8}
                style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}
              >
                No projects match.
              </td>
            </tr>
          )}
          {sorted.map((project) => {
            const isPinned = pinnedSlugs.includes(project.slug);
            const sparkData = activityData[project.slug] ?? new Array(14).fill(0);
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
                  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
                  if (diffDays < 1) return "today";
                  if (diffDays === 1) return "yesterday";
                  if (diffDays < 7) return `${diffDays}d ago`;
                  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
                  return `${Math.floor(diffDays / 30)}mo ago`;
                })()
              : "—";

            return (
              <tr
                key={project.slug}
                onClick={() => router.push(`/project/${project.slug}`)}
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid var(--border-subtle)",
                  opacity: project.status === "archived" ? 0.5 : 1,
                  transition: "background 0.1s",
                  background: isPinned ? "var(--info-bg)" : undefined,
                }}
                className="sparkline-row"
              >
                {/* Pin */}
                <td
                  style={{ padding: "4px 4px 4px 10px", verticalAlign: "middle" }}
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
                </td>

                {/* Name */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span
                      style={{
                        fontFamily: "var(--font-body)", fontSize: "0.8rem", fontWeight: 500,
                        color: "var(--text-primary)", whiteSpace: "nowrap",
                      }}
                    >
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
                </td>

                {/* Sparkline */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  <ActivitySparkline data={sparkData} />
                </td>

                {/* Last session */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                    {lastSession}
                  </span>
                </td>

                {/* Branch */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  {project.git ? (
                    <span
                      style={{
                        fontSize: "0.68rem", fontFamily: "var(--font-mono)",
                        color: project.git.isDirty ? "var(--accent)" : "var(--text-secondary)",
                        whiteSpace: "nowrap",
                      }}
                    >
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
                </td>

                {/* Todos */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  <span
                    style={{
                      fontSize: "0.72rem", fontFamily: "var(--font-mono)",
                      color: pendingTodos > 0 ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {pendingTodos > 0 ? pendingTodos : "—"}
                  </span>
                </td>

                {/* Status */}
                <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
                  <StatusBadge status={project.status} />
                </td>

                {/* Dev server */}
                <td
                  style={{ padding: "8px 10px", verticalAlign: "middle" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <DevServerControl
                    slug={project.slug}
                    projectPath={project.path}
                    devPort={project.devPort}
                    compact
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <style>{`
        .sparkline-row:hover { background: var(--muted); }
        .sparkline-row:hover .pin-btn { opacity: 1 !important; }
      `}</style>
    </div>
  );
}
