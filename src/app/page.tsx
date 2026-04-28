"use client";

import { useProjects } from "@/hooks/useProjects";
import { useGitDirtyStatus } from "@/hooks/useGitDirtyStatus";
import { DashboardGrid } from "@/components/DashboardGrid";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Home() {
  useDocumentTitle("Dashboard");
  const { data, loading, rescan, hideProject } = useProjects();
  const { statuses } = useGitDirtyStatus();

  return (
    <DashboardGrid
      projects={data?.projects ?? []}
      hiddenCount={data?.hiddenCount ?? 0}
      loading={loading}
      onRescan={rescan}
      onHide={hideProject}
      gitDirtyOverrides={statuses}
    />
  );
}
