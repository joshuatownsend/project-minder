"use client";

import { useProjects } from "@/hooks/useProjects";
import { useGitDirtyStatus } from "@/hooks/useGitDirtyStatus";
import { DashboardGrid } from "@/components/DashboardGrid";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Home() {
  useDocumentTitle("Dashboard");
  const { data, loading, rescan, archiveProject, unarchiveProject } = useProjects();
  const { statuses } = useGitDirtyStatus();

  return (
    <DashboardGrid
      projects={data?.projects ?? []}
      loading={loading}
      onRescan={rescan}
      onArchive={archiveProject}
      onUnarchive={unarchiveProject}
      scannedAt={data?.scannedAt}
      gitDirtyOverrides={statuses}
    />
  );
}
