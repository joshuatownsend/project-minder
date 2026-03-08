"use client";

import { use } from "react";
import { useProject } from "@/hooks/useProjects";
import { ProjectDetail } from "@/components/ProjectDetail";
import { ProjectStatus } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, loading } = useProject(slug);

  const handleStatusChange = async (status: ProjectStatus) => {
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, status }),
    });
    window.location.reload();
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Project not found</h2>
        <p className="text-[var(--muted-foreground)] mt-2">
          No project with slug &quot;{slug}&quot; was found.
        </p>
      </div>
    );
  }

  return (
    <ProjectDetail project={project} onStatusChange={handleStatusChange} />
  );
}
