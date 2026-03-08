"use client";

import Link from "next/link";
import { ProjectData } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { TechStackBadges } from "./TechStackBadges";
import { GitStatusCompact } from "./GitStatus";
import { ClaudeSessionCompact } from "./ClaudeSessionList";
import { TodoCompact } from "./TodoList";
import { Network, Database } from "lucide-react";

const borderColors = {
  active: "border-l-emerald-500",
  paused: "border-l-amber-500",
  archived: "border-l-gray-400",
};

export function ProjectCard({ project }: { project: ProjectData }) {
  return (
    <Link href={`/project/${project.slug}`}>
      <div
        className={`rounded-lg border border-l-4 ${borderColors[project.status]} bg-[var(--card)] p-4 hover:shadow-md transition-shadow cursor-pointer space-y-3`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold truncate">{project.name}</h3>
          <StatusBadge status={project.status} />
        </div>

        <TechStackBadges project={project} />

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
          {project.devPort && (
            <span className="flex items-center gap-1">
              <Network className="h-3 w-3" />
              :{project.devPort}
            </span>
          )}
          {project.dbPort && (
            <span className="flex items-center gap-1">
              <Database className="h-3 w-3" />
              :{project.dbPort}
            </span>
          )}
        </div>

        {project.git && <GitStatusCompact git={project.git} />}
        {project.claude && <ClaudeSessionCompact claude={project.claude} />}
        {project.todos && <TodoCompact todos={project.todos} />}
      </div>
    </Link>
  );
}
