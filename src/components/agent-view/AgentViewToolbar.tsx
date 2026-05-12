"use client";

import type { AgentSessionStatus } from "@/lib/agentView/types";

export type SortKey = "recent" | "project" | "status";

export interface AgentViewFilters {
  statuses: AgentSessionStatus[];
  project: string; // "" = all
  sort: SortKey;
}

const ALL_STATUSES: AgentSessionStatus[] = ["waiting", "working", "idle", "completed", "failed", "stopped"];
const STATUS_LABELS: Record<AgentSessionStatus, string> = {
  waiting: "Needs Input",
  working: "Working",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

interface AgentViewToolbarProps {
  filters: AgentViewFilters;
  projectNames: string[];
  onFiltersChange: (f: AgentViewFilters) => void;
  connectionState: string;
  sessionCount: number;
}

export function AgentViewToolbar({
  filters,
  projectNames,
  onFiltersChange,
  connectionState,
  sessionCount,
}: AgentViewToolbarProps) {
  function toggleStatus(s: AgentSessionStatus) {
    if (allSelected) {
      // When all are selected, clicking one focuses exclusively on that status.
      onFiltersChange({ ...filters, statuses: [s] });
      return;
    }
    const next = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onFiltersChange({ ...filters, statuses: next.length === 0 ? ALL_STATUSES : next });
  }

  const allSelected = filters.statuses.length === ALL_STATUSES.length;

  return (
    <div style={{
      display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8,
      padding: "8px 0", marginBottom: 8,
    }}>
      {/* Status filter chips */}
      <button
        type="button"
        onClick={() => onFiltersChange({ ...filters, statuses: ALL_STATUSES })}
        style={chipStyle(allSelected)}
      >
        All
      </button>
      {ALL_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => toggleStatus(s)}
          style={chipStyle(filters.statuses.includes(s) && !allSelected)}
        >
          {STATUS_LABELS[s]}
        </button>
      ))}

      <div style={{ width: 1, height: 16, background: "var(--line-soft,#222)", marginInline: 4 }} />

      {/* Project filter */}
      <select
        value={filters.project}
        onChange={(e) => onFiltersChange({ ...filters, project: e.target.value })}
        style={selectStyle}
      >
        <option value="">All projects</option>
        {projectNames.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      {/* Sort */}
      <select
        value={filters.sort}
        onChange={(e) => onFiltersChange({ ...filters, sort: e.target.value as SortKey })}
        style={selectStyle}
      >
        <option value="recent">Sort: Recent</option>
        <option value="project">Sort: Project</option>
        <option value="status">Sort: Status</option>
      </select>

      <div style={{ flex: 1 }} />

      {/* Connection state indicator */}
      <span style={{
        fontSize: "0.6rem",
        color: connectionState === "connected" ? "var(--green-text,#4ade80)"
          : connectionState === "fallback" ? "var(--amber-text,#fbbf24)"
          : "var(--text-4,#555)",
        display: "flex", alignItems: "center", gap: 4,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: connectionState === "connected" ? "var(--green-text,#4ade80)"
            : connectionState === "fallback" ? "var(--amber-text,#fbbf24)"
            : "var(--text-4,#555)",
        }} />
        {connectionState === "connected" ? "Live" : connectionState === "reconnecting" ? "Reconnecting…" : connectionState === "fallback" ? "Polling" : "Connecting…"}
        {connectionState === "connected" && sessionCount > 0 && (
          <span style={{ marginLeft: 2, color: "var(--text-3,#888)" }}>· {sessionCount}</span>
        )}
      </span>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--card-bg-2,#1a1a1a)" : "transparent",
    border: `1px solid ${active ? "var(--line-2,#333)" : "var(--line-soft,#222)"}`,
    borderRadius: 4,
    color: active ? "var(--text-1,#fff)" : "var(--text-3,#888)",
    cursor: "pointer",
    fontSize: "0.65rem",
    padding: "3px 8px",
    fontFamily: "inherit",
  };
}

const selectStyle: React.CSSProperties = {
  background: "var(--card-bg,#111)",
  border: "1px solid var(--line-soft,#222)",
  borderRadius: 4,
  color: "var(--text-2,#ccc)",
  cursor: "pointer",
  fontSize: "0.65rem",
  padding: "3px 6px",
  fontFamily: "inherit",
};
