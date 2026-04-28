"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ProjectData } from "@/lib/types";
import { pluralize } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { GitStatusCompact } from "./GitStatus";
import { ClaudeSessionCompact } from "./ClaudeSessionList";
import { DevServerControl } from "./DevServerControl";
import { PortEditor } from "./PortEditor";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { Archive, Database, MoreVertical, CheckSquare, ClipboardList, Lightbulb, Pin, PinOff } from "lucide-react";
import { StatusDot } from "./ui/StatusDot";

interface ProjectCardProps {
  project: ProjectData;
  onArchive?: (slug: string) => void;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: (slug: string) => void;
}

export function ProjectCard({ project, onArchive, compact = false, pinned = false, onTogglePin }: ProjectCardProps) {
  const [devPort, setDevPort] = useState(project.devPort);
  const router = useRouter();

  // ── Aggregate worktree counts ──────────────────────────────────────────
  const pendingTodos = (() => {
    const main = project.todos?.pending ?? 0;
    const wt = (project.worktrees ?? []).reduce(
      (acc, w) => acc + (w.todos?.pending ?? 0), 0
    );
    return main + wt;
  })();

  const pendingSteps = (() => {
    const main = project.manualSteps?.pendingSteps ?? 0;
    const wt = (project.worktrees ?? []).reduce(
      (acc, w) => acc + (w.manualSteps?.pendingSteps ?? 0), 0
    );
    return main + wt;
  })();

  const insightsTotal = (() => {
    const main = project.insights?.total ?? 0;
    const wt = (project.worktrees ?? []).reduce(
      (acc, w) => acc + (w.insights?.total ?? 0), 0
    );
    return main + wt;
  })();

  const worktreeCount = (project.worktrees ?? []).length;
  const workflowCount = project.cicd?.workflows.length ?? 0;
  const sessionStatus = project.claude?.mostRecentSessionStatus;
  const sessionId = project.claude?.mostRecentSessionId;
  const sessionBadge = sessionStatus && sessionStatus !== "idle"
    ? sessionStatus === "working"
      ? { color: "var(--status-active-text)", bg: "var(--status-active-bg)", border: "var(--status-active-border)", label: "coding",  title: "Claude is coding"           }
      : { color: "var(--accent)",             bg: "var(--accent-bg)",         border: "var(--accent-border)",         label: "waiting", title: "Claude is waiting for you" }
    : null;
  const hasAttention = pendingTodos > 0 || pendingSteps > 0;
  const isArchived   = project.status === "archived";

  // Tech stack — single compact text line
  const techParts: string[] = [];
  if (project.framework) {
    const v = project.frameworkVersion ? ` ${project.frameworkVersion}` : "";
    techParts.push(`${project.framework}${v}`);
  }
  if (project.orm)          techParts.push(project.orm);
  if (project.styling)      techParts.push(project.styling);
  if (project.monorepoType) techParts.push(project.monorepoType);
  if (project.database)     techParts.push(project.database.type);
  if (project.dockerPorts.length > 0) techParts.push("Docker");

  if (compact) {
    return (
      <Link href={`/project/${project.slug}`} style={{ display: "block", textDecoration: "none" }}>
        <div
          className="project-card"
          style={{
            display: "flex", alignItems: "center", gap: "8px",
            padding: "8px 12px",
            background: "var(--bg-surface)",
            border: hasAttention ? "1px solid var(--accent-border)" : "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            opacity: isArchived ? 0.5 : 1,
            transition: "background 0.12s, border-color 0.12s",
            cursor: "pointer",
            minHeight: "44px",
          }}
        >
          <span
            style={{
              flex: 1, minWidth: 0,
              display: "flex", alignItems: "center", gap: "5px",
              fontFamily: "var(--font-body)", fontWeight: 500, fontSize: "0.875rem",
              color: "var(--text-primary)",
            }}
          >
            {pinned && <Pin style={{ width: "9px", height: "9px", flexShrink: 0, color: "var(--info)", opacity: 0.8 }} />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: "5px", flexShrink: 0 }} onClick={(e) => e.preventDefault()}>
            {sessionBadge && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(sessionId ? `/sessions/${sessionId}` : "/sessions"); }}
                title={sessionBadge.title}
                aria-label="View active session"
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "0.62rem", fontFamily: "var(--font-mono)", letterSpacing: "0.02em",
                  color: sessionBadge.color, background: sessionBadge.bg,
                  border: `1px solid ${sessionBadge.border}`,
                  borderRadius: "3px", padding: "2px 6px", cursor: "pointer",
                }}
              >
                <StatusDot status={sessionStatus} size={6} />
                {sessionBadge.label}
              </button>
            )}
            {hasAttention && (
              <span
                title={`${pluralize(pendingTodos, "todo")}${pendingSteps > 0 ? ` + ${pluralize(pendingSteps, "manual step")}` : ""} pending`}
                style={{ fontSize: "0.6rem", color: "var(--accent)", fontFamily: "var(--font-mono)", cursor: "default" }}
              >
                {pendingTodos + pendingSteps}<span aria-hidden="true">▲</span>
                <span className="sr-only"> pending items</span>
              </span>
            )}
            <StatusBadge status={project.status} />
            {onTogglePin && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(project.slug); }}
                title={pinned ? "Unpin" : "Pin to top"}
                aria-label={pinned ? `Unpin ${project.name}` : `Pin ${project.name} to top`}
                className="compact-pin-btn"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "32px", height: "32px", padding: 0,
                  background: "none", border: "none", cursor: "pointer",
                  color: pinned ? "var(--info)" : "var(--text-muted)",
                  opacity: pinned ? 1 : 0.55,
                  transition: "opacity 0.1s, color 0.1s",
                }}
              >
                {pinned ? <PinOff style={{ width: "10px", height: "10px" }} /> : <Pin style={{ width: "10px", height: "10px" }} />}
              </button>
            )}
            <DevServerControl slug={project.slug} projectPath={project.path} devPort={devPort} compact />
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link href={`/project/${project.slug}`} style={{ display: "block", height: "100%", textDecoration: "none" }}>
      <div
        className="project-card"
        style={{
          position: "relative",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "18px 20px",
          background: pinned ? "var(--info-bg)" : "var(--bg-surface)",
          border: hasAttention
            ? "1px solid var(--accent-border)"
            : pinned
            ? "1px solid var(--info-border)"
            : "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          opacity: isArchived ? 0.5 : 1,
          transition: "background 0.12s, border-color 0.12s",
          cursor: "pointer",
        }}
      >
        {/* ── Row 1: name + status + menu ───────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
          <h3
            style={{
              flex: 1,
              fontFamily: "var(--font-body)",
              fontWeight: 500,
              fontSize: "0.875rem",
              letterSpacing: "0.01em",
              color: "var(--text-primary)",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              lineHeight: 1.35,
              minWidth: 0,
            }}
          >
            {pinned && (
              <Pin
                style={{
                  width: "9px", height: "9px",
                  color: "var(--info)", opacity: 0.8,
                  marginRight: "5px",
                  display: "inline",
                  verticalAlign: "middle",
                  position: "relative", top: "-1px",
                }}
              />
            )}
            {project.name}
          </h3>

          <div
            style={{ display: "flex", alignItems: "center", gap: "5px", flexShrink: 0 }}
            onClick={(e) => e.preventDefault()}
          >
            {sessionBadge && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(sessionId ? `/sessions/${sessionId}` : "/sessions"); }}
                title={sessionBadge.title}
                aria-label="View active session"
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "0.62rem", fontFamily: "var(--font-mono)", letterSpacing: "0.02em",
                  color: sessionBadge.color, background: sessionBadge.bg,
                  border: `1px solid ${sessionBadge.border}`,
                  borderRadius: "3px", padding: "2px 6px",
                  cursor: "pointer",
                }}
              >
                <StatusDot status={sessionStatus} size={6} />
                {sessionBadge.label}
              </button>
            )}
            <StatusBadge status={project.status} />

            {onTogglePin && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(project.slug); }}
                title={pinned ? "Unpin" : "Pin to top"}
                aria-label={pinned ? `Unpin ${project.name}` : `Pin ${project.name} to top`}
                className="pin-card-btn"
                data-pinned={pinned ? "" : undefined}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "32px", height: "32px", padding: 0,
                  background: "none", border: "none", cursor: "pointer",
                  color: pinned ? "var(--info)" : "var(--text-muted)",
                  opacity: pinned ? 1 : 0.4,
                  transition: "opacity 0.1s, color 0.1s",
                }}
              >
                {pinned ? <PinOff style={{ width: "10px", height: "10px" }} /> : <Pin style={{ width: "10px", height: "10px" }} />}
              </button>
            )}

            {onArchive && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    title="More options"
                    aria-label="More options"
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: "32px", height: "32px",
                      borderRadius: "3px", background: "transparent", border: "none",
                      color: "var(--text-muted)", cursor: "pointer", padding: 0,
                    }}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  >
                    <MoreVertical style={{ width: "12px", height: "12px" }} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                >
                  <DropdownMenuItem onClick={() => onArchive(project.slug)}>
                    <Archive style={{ width: "12px", height: "12px", marginRight: "6px" }} />
                    Archive
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* ── Row 2 (conditional): attention signals ────────────────────── */}
        {(hasAttention || insightsTotal > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {pendingTodos > 0 && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "0.72rem", fontWeight: 500,
                  color: "var(--accent)",
                }}
              >
                <CheckSquare style={{ width: "11px", height: "11px" }} />
                {pendingTodos} todo{pendingTodos !== 1 ? "s" : ""}
              </span>
            )}
            {pendingSteps > 0 && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "0.72rem", fontWeight: 500,
                  color: "var(--accent)",
                }}
              >
                <ClipboardList style={{ width: "11px", height: "11px" }} />
                {pendingSteps} step{pendingSteps !== 1 ? "s" : ""}
              </span>
            )}
            {insightsTotal > 0 && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "0.72rem", fontWeight: 500,
                  color: "var(--text-muted)",
                }}
              >
                <Lightbulb style={{ width: "11px", height: "11px" }} />
                {insightsTotal} insight{insightsTotal !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}

        {/* ── Row 3: git status ─────────────────────────────────────────── */}
        {project.git && <GitStatusCompact git={project.git} />}

        {/* ── Row 4: claude session (tertiary) ─────────────────────────── */}
        {project.claude && <ClaudeSessionCompact claude={project.claude} />}

        {/* ── Footer: pushed to bottom ──────────────────────────────────── */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>

          {/* Tech stack line */}
          {techParts.length > 0 && (
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                letterSpacing: "0.01em",
                lineHeight: 1.5,
              }}
            >
              {techParts.join(" · ")}
            </div>
          )}

          {/* Port + dev server — always shown */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
            onClick={(e) => e.preventDefault()}
          >
            {/* Port info */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                <PortEditor
                  slug={project.slug}
                  currentPort={devPort}
                  onPortChange={(p) => setDevPort(p ?? undefined)}
                  compact
                />
              </span>
              {project.dbPort && (
                <span
                  style={{
                    display: "flex", alignItems: "center", gap: "3px",
                    fontFamily: "var(--font-mono)", fontSize: "0.68rem",
                    color: "var(--text-muted)",
                  }}
                >
                  <Database style={{ width: "10px", height: "10px" }} />
                  {project.dbPort}
                </span>
              )}
              {worktreeCount > 0 && (
                <span
                  title={pluralize(worktreeCount, "worktree")}
                  style={{
                    fontSize: "0.68rem",
                    fontFamily: "var(--font-mono)",
                    color: "var(--info)",
                    background: "var(--info-bg)",
                    padding: "1px 5px",
                    borderRadius: "3px",
                  }}
                >
                  wt {worktreeCount}
                </span>
              )}
              {workflowCount > 0 && (
                <span
                  title={pluralize(workflowCount, "workflow")}
                  style={{
                    fontSize: "0.6rem",
                    fontFamily: "var(--font-mono)",
                    color: "var(--info)",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-elevated)",
                    padding: "1px 5px",
                    borderRadius: "3px",
                    letterSpacing: "0.04em",
                  }}
                >
                  CI
                </span>
              )}
            </div>

            {/* Dev server control — always rendered */}
            <DevServerControl
              slug={project.slug}
              projectPath={project.path}
              devPort={devPort}
              compact
            />
          </div>
        </div>
      </div>
    </Link>
  );
}
