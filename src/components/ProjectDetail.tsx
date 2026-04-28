"use client";

import { useEffect, useState } from "react";
import { ProjectData, ProjectStatus, TodoInfo } from "@/lib/types";
import { StatusSelector } from "./StatusBadge";
import { TodoList, AddTodoForm } from "./TodoList";
import { DevServerControl } from "./DevServerControl";
import { WorktreePanel } from "./WorktreePanel";
import { PortEditor } from "./PortEditor";
import { ManualStepsList } from "./ManualStepsList";
import { InsightsTab } from "./InsightsTab";
import { ProjectSessions } from "./ProjectSessions";
import { GitStatusCompact } from "./GitStatus";
import { MarkdownContent } from "./MarkdownContent";
import { MemoryTab } from "./MemoryTab";
import { ProjectAgentsTab } from "./ProjectAgentsTab";
import { ProjectSkillsTab } from "./ProjectSkillsTab";
import {
  ArrowLeft,
  ExternalLink,
  Terminal,
  Github,
  GitBranch,
  Clock,
  AlertCircle,
  Globe,
  Database,
  Network,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

// ── Types ──────────────────────────────────────────────────────────────────

type TabKey = "overview" | "context" | "todos" | "sessions" | "manual-steps" | "insights" | "memory" | "agents" | "skills";

interface ProjectDetailProps {
  project: ProjectData;
  onStatusChange: (status: ProjectStatus) => void;
}

// ── Section label + rule ───────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
      <span style={{
        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

// ── Overview sub-components ────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
      <span style={{
        fontSize: "0.72rem", color: "var(--text-muted)",
        fontFamily: "var(--font-body)", flexShrink: 0,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.72rem",
        color: "var(--text-secondary)", textAlign: "right",
      }}>
        {children}
      </span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export function ProjectDetail({ project, onStatusChange }: ProjectDetailProps) {
  const [devPort, setDevPort] = useState(project.devPort);
  const [todos, setTodos] = useState<TodoInfo | undefined>(project.todos);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  useEffect(() => {
    setTodos(project.todos);
  }, [project.slug, project.todos]);

  const openInVSCode = () => {
    window.open(`vscode://file/${project.path.replace(/\\/g, "/")}`, "_blank");
  };

  const openInTerminal = () => {
    window.open(`wt.exe -d "${project.path}"`, "_blank");
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: "overview",    label: "Overview" },
    { key: "context",     label: "Context" },
    { key: "todos",       label: `TODOs${todos ? ` (${todos.pending})` : ""}` },
    { key: "sessions",    label: "Sessions" },
    { key: "manual-steps", label: "Manual Steps" },
    { key: "insights",    label: "Insights" },
    { key: "memory",      label: "Memory" },
    { key: "agents",      label: "Agents" },
    { key: "skills",      label: "Skills" },
  ];

  const actionBtn = (label: string, icon: React.ReactNode, onClick: () => void, href?: string) => {
    const style: React.CSSProperties = {
      display: "inline-flex", alignItems: "center", gap: "5px",
      padding: "5px 10px",
      fontSize: "0.71rem", fontFamily: "var(--font-body)",
      color: "var(--text-secondary)",
      background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      cursor: "pointer", lineHeight: 1,
      textDecoration: "none",
      transition: "color 0.1s, border-color 0.1s",
    };
    const hoverIn = (e: React.MouseEvent) => {
      (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
      (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
    };
    const hoverOut = (e: React.MouseEvent) => {
      (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
      (e.currentTarget as HTMLElement).style.borderColor = "var(--border-subtle)";
    };
    if (href) {
      return (
        <a key={label} href={href} target="_blank" rel="noopener noreferrer"
          style={style} onMouseEnter={hoverIn} onMouseLeave={hoverOut}
        >
          {icon} {label}
        </a>
      );
    }
    return (
      <button key={label} onClick={onClick}
        style={style} onMouseEnter={hoverIn} onMouseLeave={hoverOut}
      >
        {icon} {label}
      </button>
    );
  };

  const techChips: string[] = [
    project.framework ? `${project.framework}${project.frameworkVersion ? ` ${project.frameworkVersion}` : ""}` : null,
    project.orm ?? null,
    project.styling ?? null,
    project.monorepoType ?? null,
    project.database?.type ?? null,
    project.dockerPorts.length > 0 ? "Docker" : null,
  ].filter((t): t is string => t !== null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>

      {/* ── Nav row ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingBottom: "20px" }}>
        <Link
          href="/"
          style={{
            display: "inline-flex", alignItems: "center", gap: "4px",
            fontSize: "0.72rem", color: "var(--text-secondary)", textDecoration: "none",
          }}
        >
          <ArrowLeft style={{ width: "12px", height: "12px" }} />
          Dashboard
        </Link>
        <span style={{ fontSize: "0.72rem", color: "var(--border-default)" }}>/</span>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {project.name}
        </span>
      </div>

      {/* ── Header block ────────────────────────────────────────────────── */}
      <div style={{
        padding: "18px 24px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius) var(--radius) 0 0",
        borderBottom: "none",
        display: "flex", flexDirection: "column", gap: "10px",
      }}>
        {/* Row 1: name + status + actions */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
          <h1 style={{
            fontSize: "1.15rem", fontWeight: 700,
            color: "var(--text-primary)", fontFamily: "var(--font-body)",
            letterSpacing: "-0.01em", margin: 0, flex: 1,
          }}>
            {project.name}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, flexWrap: "wrap" }}>
            <StatusSelector status={project.status} onSelect={onStatusChange} />
            <div style={{ display: "flex", gap: "4px" }}>
              {actionBtn("VS Code", <ExternalLink style={{ width: "10px", height: "10px" }} />, openInVSCode)}
              {actionBtn("Terminal", <Terminal style={{ width: "10px", height: "10px" }} />, openInTerminal)}
              {project.git?.remoteUrl && actionBtn(
                "GitHub",
                <Github style={{ width: "10px", height: "10px" }} />,
                () => {},
                project.git.remoteUrl
              )}
            </div>
          </div>
        </div>

        {/* Row 2: path */}
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: "0.68rem",
          color: "var(--text-muted)",
        }}>
          {project.path}
        </span>

        {/* Row 3: tech chips */}
        {techChips.length > 0 && (
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {techChips.map((chip) => (
              <span key={chip} style={{
                fontFamily: "var(--font-mono)", fontSize: "0.65rem",
                color: "var(--text-muted)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px", padding: "2px 6px",
              }}>
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Tab section ─────────────────────────────────────────────────── */}
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderTop: "1px solid var(--border-default)",
        borderRadius: "0 0 var(--radius) var(--radius)",
        overflow: "hidden",
      }}>
        {/* Tab bar */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "0 4px",
          borderBottom: "1px solid var(--border-subtle)",
        }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "10px 14px",
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                fontWeight: activeTab === tab.key ? 600 : 400,
                color: activeTab === tab.key ? "var(--text-primary)" : "var(--text-secondary)",
                background: "transparent", border: "none",
                borderBottom: activeTab === tab.key
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                cursor: "pointer", lineHeight: 1,
                transition: "color 0.1s",
                marginBottom: "-1px",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: "20px 24px" }}>

          {/* ── OVERVIEW ──────────────────────────────────────────────── */}
          {activeTab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              <DevServerControl
                slug={project.slug}
                projectPath={project.path}
                devPort={devPort}
              />

              {project.worktrees && project.worktrees.length > 0 && (
                <WorktreePanel
                  slug={project.slug}
                  devPort={devPort}
                  worktrees={project.worktrees}
                />
              )}

              {/* Git */}
              {project.git && (
                <div>
                  <SectionHeader label="Git" />
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <GitBranch style={{ width: "13px", height: "13px", color: "var(--text-muted)", flexShrink: 0 }} />
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--text-primary)", fontWeight: 600 }}>
                        {project.git.branch}
                      </span>
                      {project.git.isDirty && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--accent)", fontSize: "0.72rem", fontFamily: "var(--font-mono)" }}>
                          <AlertCircle style={{ width: "11px", height: "11px" }} />
                          {project.git.uncommittedCount} uncommitted
                        </span>
                      )}
                      {project.git.remoteUrl && (
                        <a href={project.git.remoteUrl} target="_blank" rel="noopener noreferrer"
                          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.68rem", color: "var(--text-muted)", textDecoration: "none" }}
                          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--text-secondary)")}
                          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--text-muted)")}
                        >
                          <Github style={{ width: "11px", height: "11px" }} />
                          GitHub
                        </a>
                      )}
                    </div>
                    {project.git.lastCommitMessage && (
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", paddingLeft: "23px" }}>
                        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {project.git.lastCommitMessage}
                        </span>
                        {project.git.lastCommitDate && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.68rem", color: "var(--text-muted)", flexShrink: 0 }}>
                            <Clock style={{ width: "10px", height: "10px" }} />
                            {formatDistanceToNow(new Date(project.git.lastCommitDate), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Infrastructure: ports + database + services */}
              {(devPort || project.dbPort || project.dockerPorts.length > 0 || project.database || project.externalServices.length > 0) && (
                <div>
                  <SectionHeader label="Infrastructure" />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "20px" }}>

                    {/* Ports */}
                    {(devPort || project.dbPort || project.dockerPorts.length > 0) && (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                          <Network style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
                          <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-body)" }}>
                            Ports
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <InfoRow label="Dev">
                            <PortEditor
                              slug={project.slug}
                              currentPort={devPort}
                              onPortChange={(p) => setDevPort(p ?? undefined)}
                            />
                          </InfoRow>
                          {project.dbPort && (
                            <InfoRow label="Database">:{project.dbPort}</InfoRow>
                          )}
                          {project.dockerPorts.map((dp, i) => (
                            <InfoRow key={i} label={`Docker ${dp.service}`}>
                              :{dp.host}
                            </InfoRow>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Database */}
                    {project.database && (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                          <Database style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
                          <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-body)" }}>
                            Database
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <InfoRow label="Type">{project.database.type}</InfoRow>
                          <InfoRow label="Host">{project.database.host}</InfoRow>
                          <InfoRow label="Port">{project.database.port}</InfoRow>
                          <InfoRow label="Name">{project.database.name}</InfoRow>
                        </div>
                      </div>
                    )}

                    {/* External services */}
                    {project.externalServices.length > 0 && (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                          <Globe style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
                          <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-body)" }}>
                            Services
                          </span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                          {project.externalServices.map((svc) => (
                            <span key={svc} style={{
                              fontFamily: "var(--font-mono)", fontSize: "0.68rem",
                              color: "var(--text-secondary)",
                              background: "var(--bg-elevated)",
                              border: "1px solid var(--border-subtle)",
                              borderRadius: "3px", padding: "2px 6px",
                            }}>
                              {svc}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── CONTEXT ───────────────────────────────────────────────── */}
          {activeTab === "context" && (
            <div>
              {project.claude?.claudeMdSummary ? (
                <MarkdownContent content={project.claude.claudeMdSummary} />
              ) : (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "48px 0", margin: 0 }}>
                  No CLAUDE.md found for this project.
                </p>
              )}
            </div>
          )}

          {/* ── TODOS ─────────────────────────────────────────────────── */}
          {activeTab === "todos" && (
            <div>
              {todos ? (
                <TodoList todos={todos} slug={project.slug} onChange={setTodos} worktrees={project.worktrees} />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
                    No TODO items found. Add one below to create <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em", color: "var(--accent)", background: "var(--accent-bg)", padding: "1px 4px", borderRadius: "3px" }}>TODO.md</code>.
                  </p>
                  <AddTodoForm slug={project.slug} onAddedAction={setTodos} />
                  {project.worktrees?.some((wt) => wt.todos) && (
                    <TodoList
                      todos={{ total: 0, completed: 0, pending: 0, items: [] }}
                      worktrees={project.worktrees}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── SESSIONS ──────────────────────────────────────────────── */}
          {activeTab === "sessions" && (
            <ProjectSessions projectPath={project.path} />
          )}

          {/* ── MANUAL STEPS ──────────────────────────────────────────── */}
          {activeTab === "manual-steps" && (
            <div>
              {project.manualSteps || project.worktrees?.some((wt) => wt.manualSteps) ? (
                <ManualStepsList
                  slug={project.slug}
                  initialData={project.manualSteps ?? { entries: [], totalSteps: 0, completedSteps: 0, pendingSteps: 0 }}
                  worktrees={project.worktrees}
                />
              ) : (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", padding: "48px 0", margin: 0 }}>
                  No MANUAL_STEPS.md found for this project.
                </p>
              )}
            </div>
          )}

          {/* ── INSIGHTS ──────────────────────────────────────────────── */}
          {activeTab === "insights" && (
            <InsightsTab slug={project.slug} worktrees={project.worktrees} />
          )}

          {/* ── MEMORY ────────────────────────────────────────────────── */}
          {activeTab === "memory" && (
            <MemoryTab slug={project.slug} />
          )}

          {/* ── AGENTS ───────────────────────────────────────────────── */}
          {activeTab === "agents" && (
            <ProjectAgentsTab slug={project.slug} />
          )}

          {/* ── SKILLS ───────────────────────────────────────────────── */}
          {activeTab === "skills" && (
            <ProjectSkillsTab slug={project.slug} />
          )}
        </div>
      </div>
    </div>
  );
}
