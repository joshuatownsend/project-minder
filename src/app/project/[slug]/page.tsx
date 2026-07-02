"use client";

import { use } from "react";
import { useProject } from "@/hooks/useProjects";
import { ProjectDetail } from "@/components/ProjectDetail";
import { ProjectStatus } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useServerActionsEnabled } from "@/components/ConfigProvider";
import { setProjectStatusAction } from "@/lib/server/actions";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, loading, refresh } = useProject(slug);
  const useAction = useServerActionsEnabled();

  useDocumentTitle(project?.name ?? slug);

  const handleStatusChange = async (status: ProjectStatus) => {
    // Fired from StatusSelector.onSelect, which doesn't await/catch — so a
    // rejection (e.g. the Server Action throwing) would surface as an unhandled
    // promise rejection in the browser. Swallow here; the UI resyncs on next
    // load, matching the dashboard's updateStatus.
    try {
      if (useAction) {
        // Server Action path: write, then re-fetch just this project — no full
        // page reload.
        await setProjectStatusAction(slug, status);
        await refresh();
        return;
      }
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, status }),
      });
      window.location.reload();
    } catch {
      // network / action error — leave current UI in place
    }
  };

  if (loading) {
    return (
      <div className="shell-content wide space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="shell-content wide text-center py-12">
        <h2 className="text-xl font-semibold">Project not found</h2>
        <p className="text-[var(--muted-foreground)] mt-2">
          No project with slug &quot;{slug}&quot; was found.
        </p>
      </div>
    );
  }

  return (
    <div className="shell-content wide">
      <ProjectDetail project={project} onStatusChange={handleStatusChange} />
    </div>
  );
}
