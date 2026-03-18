"use client";

import { useProjects } from "@/hooks/useProjects";
import { useGitDirtyStatus } from "@/hooks/useGitDirtyStatus";
import { DashboardGrid } from "@/components/DashboardGrid";

export default function Home() {
  const { data, loading, rescan, hideProject } = useProjects();
  const { statuses } = useGitDirtyStatus();

  return (
    <DashboardGrid
      projects={data?.projects ?? []}
      portConflicts={data?.portConflicts ?? []}
      hiddenCount={data?.hiddenCount ?? 0}
      loading={loading}
      onRescan={rescan}
      onHide={hideProject}
      gitDirtyOverrides={statuses}
    />
  );
}
