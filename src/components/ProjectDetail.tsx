"use client";

import { useEffect, useState } from "react";
import { ProjectData, ProjectStatus, TodoInfo } from "@/lib/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { StatusSelector } from "./StatusBadge";
import { TechStackBadges } from "./TechStackBadges";
import { GitStatus } from "./GitStatus";
import { ClaudeSessionList } from "./ClaudeSessionList";
import { TodoList, AddTodoForm } from "./TodoList";
import { DevServerControl } from "./DevServerControl";
import { PortEditor } from "./PortEditor";
import { ManualStepsList } from "./ManualStepsList";
import { InsightsTab } from "./InsightsTab";
import { ProjectSessions } from "./ProjectSessions";
import {
  ArrowLeft,
  ExternalLink,
  Terminal,
  Network,
  Database,
  Github,
  Globe,
  FolderOpen,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { WorktreeSection } from "./WorktreeSection";
import Link from "next/link";

interface ProjectDetailProps {
  project: ProjectData;
  onStatusChange: (status: ProjectStatus) => void;
}

export function ProjectDetail({ project, onStatusChange }: ProjectDetailProps) {
  const [devPort, setDevPort] = useState(project.devPort);
  const [todos, setTodos] = useState<TodoInfo | undefined>(project.todos);

  // Resync local TODO state when the component receives a different project
  // (e.g. client-side route transitions between /project/[slug] pages).
  useEffect(() => {
    setTodos(project.todos);
  }, [project.slug, project.todos]);

  const openInVSCode = () => {
    window.open(`vscode://file/${project.path.replace(/\\/g, "/")}`, "_blank");
  };

  const openInTerminal = () => {
    // Windows Terminal
    window.open(
      `wt.exe -d "${project.path}"`,
      "_blank"
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-sm text-[var(--muted-foreground)] font-mono">
            {project.path}
          </p>
          <TechStackBadges project={project} />
        </div>

        <div className="flex flex-col gap-2 items-end">
          <StatusSelector status={project.status} onSelect={onStatusChange} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={openInVSCode}>
              <ExternalLink className="h-4 w-4 mr-1" />
              VS Code
            </Button>
            <Button variant="outline" size="sm" onClick={openInTerminal}>
              <Terminal className="h-4 w-4 mr-1" />
              Terminal
            </Button>
            {project.git?.remoteUrl && (
              <a href={project.git.remoteUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  <Github className="h-4 w-4 mr-1" />
                  GitHub
                </Button>
              </a>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
          <TabsTrigger value="todos">TODOs</TabsTrigger>
          <TabsTrigger value="claude">Claude</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="manual-steps">Manual Steps</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Dev Server Control */}
          <DevServerControl
            slug={project.slug}
            projectPath={project.path}
            devPort={devPort}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Ports */}
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <Network className="h-4 w-4" />
                Ports
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--muted-foreground)]">Dev Server</span>
                  <PortEditor
                    slug={project.slug}
                    currentPort={devPort}
                    onPortChange={(p) => setDevPort(p ?? undefined)}
                  />
                </div>
                {project.dbPort && (
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Database</span>
                    <span className="font-mono">{project.dbPort}</span>
                  </div>
                )}
                {project.dockerPorts.map((dp, i) => (
                  <div key={i} className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">
                      Docker: {dp.service}
                    </span>
                    <span className="font-mono">
                      {dp.host}:{dp.container}
                    </span>
                  </div>
                ))}
                {!project.devPort && !project.dbPort && project.dockerPorts.length === 0 && (
                  <p className="text-[var(--muted-foreground)]">No ports detected</p>
                )}
              </div>
            </div>

            {/* Database */}
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <Database className="h-4 w-4" />
                Database
              </h3>
              {project.database ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Type</span>
                    <span>{project.database.type}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Host</span>
                    <span className="font-mono">{project.database.host}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Port</span>
                    <span className="font-mono">{project.database.port}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Name</span>
                    <span className="font-mono">{project.database.name}</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">No database detected</p>
              )}
            </div>

            {/* External Services */}
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <Globe className="h-4 w-4" />
                External Services
              </h3>
              {project.externalServices.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {project.externalServices.map((service) => (
                    <Badge key={service} variant="outline">
                      {service}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">
                  No external services detected
                </p>
              )}
            </div>

            {/* Git */}
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <FolderOpen className="h-4 w-4" />
                Git Status
              </h3>
              {project.git ? (
                <GitStatus git={project.git} />
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">No git info</p>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="context">
          {project.claude?.claudeMdSummary ? (
            <div className="rounded-lg border p-6">
              <h3 className="font-medium mb-4">CLAUDE.md</h3>
              <pre className="whitespace-pre-wrap text-sm font-mono text-[var(--muted-foreground)]">
                {project.claude.claudeMdSummary}
              </pre>
            </div>
          ) : (
            <p className="text-[var(--muted-foreground)] py-8 text-center">
              No CLAUDE.md found for this project.
            </p>
          )}
        </TabsContent>

        <TabsContent value="todos">
          <div className="rounded-lg border p-6">
            {todos ? (
              <TodoList todos={todos} slug={project.slug} onChange={setTodos} worktrees={project.worktrees} />
            ) : project.worktrees?.some((wt) => wt.todos) ? (
              <div className="space-y-4">
                <p className="text-[var(--muted-foreground)] text-sm">
                  No TODO items on main branch.
                </p>
                <AddTodoForm slug={project.slug} onAdded={setTodos} />
                {project.worktrees.map((wt) =>
                  wt.todos ? (
                    <WorktreeSection
                      key={wt.worktreePath}
                      branch={wt.branch}
                      itemCount={wt.todos.total}
                      itemLabel={wt.todos.total === 1 ? "TODO" : "TODOs"}
                    >
                      <ul className="space-y-1">
                        {wt.todos.items.map((item, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            {item.completed ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                            ) : (
                              <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
                            )}
                            <span className={item.completed ? "line-through text-[var(--muted-foreground)]" : ""}>
                              {item.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </WorktreeSection>
                  ) : null
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-[var(--muted-foreground)] text-sm">
                  No TODO items found for this project. Add an item below to create or seed <code>TODO.md</code>.
                </p>
                <AddTodoForm slug={project.slug} onAdded={setTodos} />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="claude">
          {project.claude ? (
            <div className="rounded-lg border p-6">
              <ClaudeSessionList claude={project.claude} />
            </div>
          ) : (
            <p className="text-[var(--muted-foreground)] py-8 text-center">
              No Claude session data found.
            </p>
          )}
        </TabsContent>

        <TabsContent value="sessions">
          <ProjectSessions projectPath={project.path} />
        </TabsContent>

        <TabsContent value="manual-steps">
          {project.manualSteps ? (
            <div className="rounded-lg border p-6">
              <ManualStepsList
                slug={project.slug}
                initialData={project.manualSteps}
                worktrees={project.worktrees}
              />
            </div>
          ) : project.worktrees?.some((wt) => wt.manualSteps) ? (
            <div className="rounded-lg border p-6">
              <p className="text-[var(--muted-foreground)] text-sm mb-4">
                No MANUAL_STEPS.md on main branch.
              </p>
              {project.worktrees.map((wt) =>
                wt.manualSteps && wt.manualSteps.totalSteps > 0 ? (
                  <WorktreeSection
                    key={wt.worktreePath}
                    branch={wt.branch}
                    itemCount={wt.manualSteps.totalSteps}
                    itemLabel={wt.manualSteps.totalSteps === 1 ? "step" : "steps"}
                  >
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {wt.manualSteps.pendingSteps} pending
                    </p>
                  </WorktreeSection>
                ) : null
              )}
            </div>
          ) : (
            <p className="text-[var(--muted-foreground)] py-8 text-center">
              No MANUAL_STEPS.md found for this project.
            </p>
          )}
        </TabsContent>

        <TabsContent value="insights">
          <div className="rounded-lg border p-6">
            <InsightsTab slug={project.slug} worktrees={project.worktrees} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
