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

  return (
    <Link href={`/project/${project.slug}`}>
      <div
        className={`group rounded-lg border border-l-4 ${borderColors[project.status]} bg-[var(--card)] p-4 hover:shadow-md transition-shadow cursor-pointer space-y-3`}
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
        {project.todos && <TodoCompact todos={project.todos} />}
        {project.manualSteps && <ManualStepsCompact manualSteps={project.manualSteps} />}
      </div>
    </Link>
  );
}
