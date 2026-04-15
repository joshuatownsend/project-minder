"use client";

import { useState, useEffect, useMemo } from "react";
import { SessionSummary } from "@/lib/types";
import { StatCard } from "./stats/StatCard";
import { BarChart } from "./stats/BarChart";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import {
  Clock,
  Cpu,
  MessageSquare,
  GitBranch,
  Bot,
  Wrench,
  AlertCircle,
  DollarSign,
  Layers,
} from "lucide-react";
import Link from "next/link";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
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

/** Picks the best label for a session row using a priority cascade.
 *  lastRecap → initialPrompt → lastPrompt → branch → "Untitled session"
 *  Recap wins because it's the AI's summary of what was accomplished —
 *  more informative than the opening prompt for completed sessions. */
function sessionLabel(session: SessionSummary): { primary: string; secondary?: string; isRecap: boolean; isPlaceholder: boolean } {
  const lastRecap = session.recaps?.[session.recaps.length - 1]?.content?.trim();
  const first = session.initialPrompt?.trim();
  const last = session.lastPrompt?.trim();

  if (lastRecap) {
    // Show the opening prompt as secondary context when it adds something different
    return {
      primary: lastRecap,
      secondary: first && first !== lastRecap ? first : undefined,
      isRecap: true,
      isPlaceholder: false,
    };
  }
  if (first) {
    return {
      primary: first,
      secondary: last && last !== first ? last : undefined,
      isRecap: false,
      isPlaceholder: false,
    };
  }
  if (last) {
    return { primary: last, isRecap: false, isPlaceholder: false };
  }
  if (session.gitBranch) {
    return { primary: session.gitBranch, isRecap: false, isPlaceholder: true };
  }
  return { primary: "Untitled session", isRecap: false, isPlaceholder: true };
}

export function ProjectSessions({ projectPath }: { projectPath: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Respect user's motion preference for the active ping animation
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    // Match via projectName (raw encoded dir, e.g. "C--dev-project-minder") to avoid
    // the lossy decodeDirName() path which corrupts hyphenated project names.
    const encoded = projectPath.replace(/[:\\/]/g, "-");
    // Pass encoded name as query param to reduce JSON payload — exact client-side
    // filter below guards against the API's looser substring match.
    fetch(`/api/sessions?project=${encodeURIComponent(encoded)}`)
      .then((res) => res.json())
      .then((all: SessionSummary[]) => {
        setSessions(all.filter((s) => s.projectName === encoded));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectPath]);

  const stats = useMemo(() => {
    if (sessions.length === 0) return null;
    const totalTokens = sessions.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    const totalCost = sessions.reduce((s, x) => s + x.costEstimate, 0);
    const totalDuration = sessions.reduce((s, x) => s + (x.durationMs || 0), 0);
    const totalMessages = sessions.reduce((s, x) => s + x.messageCount, 0);
    const totalErrors = sessions.reduce((s, x) => s + x.errorCount, 0);
    const models = new Set<string>();
    const toolAgg: Record<string, number> = {};
    for (const s of sessions) {
      for (const m of s.modelsUsed) models.add(m);
      for (const [tool, count] of Object.entries(s.toolUsage)) {
        toolAgg[tool] = (toolAgg[tool] || 0) + count;
      }
    }
    return { totalTokens, totalCost, totalDuration, totalMessages, totalErrors, modelsUsed: Array.from(models), toolUsage: toolAgg };
  }, [sessions]);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>
        No sessions yet. Sessions appear here once Claude Code has been run in this project directory.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Aggregated stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
        <StatCard label="Sessions" value={sessions.length} icon={<Layers className="h-4 w-4" />} />
        <StatCard label="Total Time" value={formatDuration(stats!.totalDuration)} icon={<Clock className="h-4 w-4" />} />
        <StatCard label="Messages" value={stats!.totalMessages} icon={<MessageSquare className="h-4 w-4" />} />
        <StatCard label="Tokens" value={formatTokens(stats!.totalTokens)} icon={<Cpu className="h-4 w-4" />} />
        <StatCard label="Cost" value={formatCost(stats!.totalCost)} icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Errors" value={stats!.totalErrors} icon={<AlertCircle className="h-4 w-4" />} />
      </div>

      {/* Tool usage + models */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "24px" }}>
        <div style={{
          borderRadius: "8px",
          border: "1px solid var(--border)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}>
          <h3 style={{ fontSize: "0.875rem", fontWeight: 500, display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
            <Wrench aria-hidden="true" style={{ width: "16px", height: "16px" }} />
            Tool Usage
          </h3>
          <BarChart data={stats!.toolUsage} color="var(--accent)" />
        </div>
        <div style={{
          borderRadius: "8px",
          border: "1px solid var(--border)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}>
          <h3 style={{ fontSize: "0.875rem", fontWeight: 500, margin: 0 }}>Models Used</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {stats!.modelsUsed.map((m) => (
              <Badge key={m} variant="outline">{m}</Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Session list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h3 style={{ fontSize: "0.875rem", fontWeight: 500, margin: 0 }}>All Sessions</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {sessions.map((session) => {
            const totalTools = Object.values(session.toolUsage).reduce((s, c) => s + c, 0);
            const label = sessionLabel(session);
            return (
              <Link key={session.sessionId} href={`/sessions/${session.sessionId}`} style={{ textDecoration: "none" }}>
                <div
                  style={{
                    borderRadius: "8px",
                    border: "1px solid var(--border)",
                    padding: "12px",
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--muted)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Primary label */}
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {session.isActive && (
                          <span aria-label="Active session" style={{ position: "relative", display: "flex", width: "8px", height: "8px", flexShrink: 0 }}>
                            <span style={{
                              position: "absolute", inset: 0,
                              borderRadius: "50%",
                              background: "var(--status-active-text)",
                              opacity: 0.6,
                              animation: reducedMotion ? "none" : "ping 1s cubic-bezier(0,0,0.2,1) infinite",
                            }} />
                            <span style={{ position: "relative", width: "8px", height: "8px", borderRadius: "50%", background: "var(--status-active-text)" }} />
                          </span>
                        )}
                        {label.isRecap && (
                          <span style={{
                            fontSize: "0.6rem", fontFamily: "var(--font-mono)",
                            fontWeight: 600, letterSpacing: "0.04em",
                            color: "var(--accent)", background: "var(--accent-bg)",
                            border: "1px solid var(--accent-border)",
                            borderRadius: "3px", padding: "1px 5px",
                            flexShrink: 0,
                          }}>
                            recap
                          </span>
                        )}
                        <p style={{
                          fontSize: "0.875rem",
                          margin: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: label.isPlaceholder ? "var(--text-muted)" : "var(--text-primary)",
                          fontStyle: label.isPlaceholder ? "italic" : "normal",
                        }}>
                          {label.primary}
                        </p>
                      </div>
                      {/* Secondary context — opening prompt when recap is the primary label */}
                      {label.secondary && (
                        <p style={{
                          fontSize: "0.75rem",
                          margin: "2px 0 0 0",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "var(--text-muted)",
                        }}>
                          ↳ {label.secondary}
                        </p>
                      )}
                      {/* Meta row */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "4px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          <Clock aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                          {formatDuration(session.durationMs)}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          <MessageSquare aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                          {session.messageCount}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          <Cpu aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                          {formatTokens(session.inputTokens + session.outputTokens)}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          <Wrench aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                          {totalTools}
                        </span>
                        {session.subagentCount > 0 && (
                          <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            <Bot aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                            {session.subagentCount}
                          </span>
                        )}
                        {session.gitBranch && (
                          <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            <GitBranch aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                            {session.gitBranch}
                          </span>
                        )}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", flexShrink: 0 }}>
                      {formatDate(session.endTime)}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
