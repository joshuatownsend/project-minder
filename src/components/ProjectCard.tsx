"use client";

import { useState } from "react";
import Link from "next/link";
import { ProjectData } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { TechStackBadges } from "./TechStackBadges";
import { GitStatusCompact } from "./GitStatus";
import { ClaudeSessionCompact } from "./ClaudeSessionList";
import { TodoCompact } from "./TodoList";
import { ManualStepsCompact } from "./ManualStepsCompact";
import { InsightsCompact } from "./InsightsCompact";
import { DevServerControl } from "./DevServerControl";
import { PortEditor } from "./PortEditor";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { Network, Database, MoreVertical, EyeOff } from "lucide-react";

const borderColors = {
  active: "border-l-emerald-500",
  paused: "border-l-amber-500",
  archived: "border-l-gray-400",
};

interface ProjectCardProps {
  project: ProjectData;
  onHide?: (slug: string, dirName: string) => void;
}

export function ProjectCard({ project, onHide }: ProjectCardProps) {
  const [devPort, setDevPort] = useState(project.devPort);

  const dirName = project.path.split(/[\\/]/).pop() || project.slug;

  // Aggregate worktree counts into badge data
  const aggregatedTodos = (() => {
    if (!project.todos && !project.worktrees?.some((wt) => wt.todos)) return undefined;
    const mainTodos = project.todos ?? { total: 0, completed: 0, pending: 0, items: [] };
    const wtTotals = (project.worktrees ?? []).reduce(
      (acc, wt) => {
        if (!wt.todos) return acc;
        return {
          total: acc.total + wt.todos.total,
          completed: acc.completed + wt.todos.completed,
          pending: acc.pending + wt.todos.pending,
        };
      },
      { total: 0, completed: 0, pending: 0 }
    );
    return {
      total: mainTodos.total + wtTotals.total,
      completed: mainTodos.completed + wtTotals.completed,
      pending: mainTodos.pending + wtTotals.pending,
      items: mainTodos.items,
    };
  })();

  const aggregatedManualSteps = (() => {
    if (!project.manualSteps && !project.worktrees?.some((wt) => wt.manualSteps)) return undefined;
    const main = project.manualSteps ?? { entries: [], totalSteps: 0, completedSteps: 0, pendingSteps: 0 };
    const wtTotals = (project.worktrees ?? []).reduce(
      (acc, wt) => {
        if (!wt.manualSteps) return acc;
        return {
          totalSteps: acc.totalSteps + wt.manualSteps.totalSteps,
          completedSteps: acc.completedSteps + wt.manualSteps.completedSteps,
          pendingSteps: acc.pendingSteps + wt.manualSteps.pendingSteps,
        };
      },
      { totalSteps: 0, completedSteps: 0, pendingSteps: 0 }
    );
    return {
      entries: main.entries,
      totalSteps: main.totalSteps + wtTotals.totalSteps,
      completedSteps: main.completedSteps + wtTotals.completedSteps,
      pendingSteps: main.pendingSteps + wtTotals.pendingSteps,
    };
  })();

  const aggregatedInsights = (() => {
    if (!project.insights && !project.worktrees?.some((wt) => wt.insights)) return undefined;
    const main = project.insights ?? { entries: [], total: 0 };
    const wtTotal = (project.worktrees ?? []).reduce(
      (acc, wt) => acc + (wt.insights?.total ?? 0),
      0
    );
    return {
      entries: main.entries,
      total: main.total + wtTotal,
    };
  })();

  return (
    <Link href={`/project/${project.slug}`} className="h-full">
      <div
        className={`group rounded-lg border border-l-4 ${borderColors[project.status]} bg-[var(--card)] p-4 hover:shadow-md transition-shadow cursor-pointer space-y-3 h-full`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold truncate">{project.name}</h3>
          <div className="flex items-center gap-1 shrink-0">
            <StatusBadge status={project.status} />
            {onHide && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <DropdownMenuItem
                    onClick={() => {
                      if (
                        window.confirm(
                          `Hide "${project.name}" from the dashboard? You can unhide it later.`
                        )
                      ) {
                        onHide(project.slug, dirName);
                      }
                    }}
                  >
                    <EyeOff className="h-4 w-4 mr-2" />
                    Hide project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <TechStackBadges project={project} />

        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1">
              <Network className="h-3 w-3" />
              <PortEditor
                slug={project.slug}
                currentPort={devPort}
                onPortChange={(p) => setDevPort(p ?? undefined)}
                compact
              />
            </span>
            {project.dbPort && (
              <span className="flex items-center gap-1">
                <Database className="h-3 w-3" />
                :{project.dbPort}
              </span>
            )}
          </div>
          {devPort && (
            <DevServerControl
              slug={project.slug}
              projectPath={project.path}
              devPort={devPort}
              compact
            />
          )}
        </div>

        {project.git && <GitStatusCompact git={project.git} />}
        {project.claude && <ClaudeSessionCompact claude={project.claude} />}
        {aggregatedTodos && <TodoCompact todos={aggregatedTodos} />}
        {aggregatedManualSteps && <ManualStepsCompact manualSteps={aggregatedManualSteps} />}
        {aggregatedInsights && <InsightsCompact insights={aggregatedInsights} />}
      </div>
    </Link>
  );
}
