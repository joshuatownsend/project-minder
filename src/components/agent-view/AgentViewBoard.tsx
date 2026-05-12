"use client";

import { useState, useMemo } from "react";
import { useAgentViewStream } from "@/lib/agentView/useAgentViewStream";
import { AgentCard } from "./AgentCard";
import { AgentPeekPanel } from "./AgentPeekPanel";
import { AgentViewToolbar, type AgentViewFilters } from "./AgentViewToolbar";
import type { LiveAgentSession, AgentSessionStatus, ConnectionState } from "@/lib/agentView/types";
import { ALL_STATUSES, STATUS_ORDER } from "@/lib/agentView/types";

const COLUMN_ORDER: AgentSessionStatus[] = ["waiting", "working", "idle", "completed", "failed", "stopped"];
const COLUMN_LABELS: Record<AgentSessionStatus, string> = {
  waiting:   "Needs Input",
  working:   "Working",
  idle:      "Idle",
  completed: "Completed",
  failed:    "Failed",
  stopped:   "Stopped",
};
const COLUMN_COLORS: Record<AgentSessionStatus, string> = {
  waiting:   "var(--amber-text,#fbbf24)",
  working:   "var(--blue-text,#60a5fa)",
  idle:      "var(--text-4,#555)",
  completed: "var(--green-text,#4ade80)",
  failed:    "var(--red-text,#f87171)",
  stopped:   "var(--text-4,#555)",
};

function sortSessions(sessions: LiveAgentSession[], key: AgentViewFilters["sort"]): LiveAgentSession[] {
  const copy = [...sessions];
  if (key === "project") {
    copy.sort((a, b) => a.projectName.localeCompare(b.projectName));
  } else if (key === "status") {
    copy.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.secondsSinceChange - b.secondsSinceChange);
  } else {
    copy.sort((a, b) => a.secondsSinceChange - b.secondsSinceChange);
  }
  return copy;
}

export function AgentViewBoard() {
  const { sessions, connectionState, lastEventAt } = useAgentViewStream();
  const [peekedSession, setPeekedSession] = useState<LiveAgentSession | null>(null);
  const [filters, setFilters] = useState<AgentViewFilters>({
    statuses: ALL_STATUSES,
    project: "",
    sort: "recent",
  });

  const projectNames = useMemo(
    () => [...new Set(sessions.map((s) => s.projectName))].sort(),
    [sessions],
  );

  const filtered = useMemo(() => {
    let list = sessions;
    if (filters.project) list = list.filter((s) => s.projectName === filters.project);
    const isAllStatuses = filters.statuses.length === ALL_STATUSES.length;
    if (!isAllStatuses) list = list.filter((s) => filters.statuses.includes(s.status));
    return sortSessions(list, filters.sort);
  }, [sessions, filters]);

  const byStatus = useMemo(() => {
    const map = new Map<AgentSessionStatus, LiveAgentSession[]>();
    for (const s of COLUMN_ORDER) map.set(s, []);
    for (const s of filtered) map.get(s.status)?.push(s);
    return map;
  }, [filtered]);

  // Only render columns that are filtered-in or have sessions
  const visibleColumns = COLUMN_ORDER.filter(
    (s) => (byStatus.get(s)?.length ?? 0) > 0 || filters.statuses.includes(s),
  );

  const isEmpty = filtered.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <AgentViewToolbar
        filters={filters}
        projectNames={projectNames}
        onFiltersChange={setFilters}
        connectionState={connectionState}
        sessionCount={filtered.length}
        lastEventAt={lastEventAt}
      />

      {isEmpty ? (
        <EmptyState connectionState={connectionState} />
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${visibleColumns.length}, minmax(220px, 1fr))`,
          gap: 12,
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          alignItems: "start",
        }}>
          {visibleColumns.map((status) => {
            const cols = byStatus.get(status) ?? [];
            return (
              <div key={status} style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 120 }}>
                {/* Column header */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "4px 0 8px",
                  borderBottom: `2px solid ${COLUMN_COLORS[status]}22`,
                }}>
                  <span style={{
                    fontSize: "0.65rem", fontWeight: 700,
                    letterSpacing: "0.08em", textTransform: "uppercase",
                    color: COLUMN_COLORS[status],
                  }}>
                    {COLUMN_LABELS[status]}
                  </span>
                  {cols.length > 0 && (
                    <span style={{
                      fontSize: "0.6rem",
                      background: `${COLUMN_COLORS[status]}22`,
                      color: COLUMN_COLORS[status],
                      border: `1px solid ${COLUMN_COLORS[status]}44`,
                      borderRadius: 3,
                      padding: "0 5px",
                      lineHeight: 1.6,
                    }}>
                      {cols.length}
                    </span>
                  )}
                </div>
                {/* Cards */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {cols.map((s) => (
                    <AgentCard key={s.sessionId} session={s} onPeek={setPeekedSession} />
                  ))}
                  {cols.length === 0 && (
                    <div style={{
                      border: "1px dashed var(--line-soft,#222)",
                      borderRadius: 6,
                      height: 60,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "var(--text-4,#555)",
                      fontSize: "0.6rem",
                    }}>
                      empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AgentPeekPanel session={peekedSession} onClose={() => setPeekedSession(null)} />
    </div>
  );
}

function EmptyState({ connectionState }: { connectionState: ConnectionState }) {
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 12, paddingBottom: 48,
    }}>
      <div style={{ fontSize: "2rem", opacity: 0.25 }}>&#9678;</div>
      <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-2,#ccc)" }}>
        No active sessions
      </div>
      <div style={{ fontSize: "0.7rem", color: "var(--text-4,#555)", textAlign: "center", maxWidth: 380 }}>
        {isConnecting ? "Connecting to live session stream…" : (
          <>
            Start a Claude Code session in any project to see it here. Background sessions launched with{" "}
            <code style={{ fontFamily: "var(--font-mono,monospace)", background: "var(--card-bg-2,#1a1a1a)", padding: "0 4px", borderRadius: 3 }}>
              claude --bg
            </code>
            {" "}appear here automatically.
          </>
        )}
      </div>
    </div>
  );
}
