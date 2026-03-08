"use client";

import { useProjects } from "@/hooks/useProjects";
import { DashboardGrid } from "@/components/DashboardGrid";

export default function Home() {
  const { data, loading, rescan } = useProjects();

  return (
    <DashboardGrid
      projects={data?.projects ?? []}
      portConflicts={data?.portConflicts ?? []}
      loading={loading}
      onRescan={rescan}
    />
  );
}
