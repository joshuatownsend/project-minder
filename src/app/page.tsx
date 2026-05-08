"use client";

import { useEffect, useState } from "react";
import { useProjects } from "@/hooks/useProjects";
import { useGitDirtyStatus } from "@/hooks/useGitDirtyStatus";
import { useEfficiencyGrades } from "@/hooks/useEfficiencyGrades";
import { DashboardGrid } from "@/components/DashboardGrid";
import { DecisionsPanel } from "@/components/DecisionsPanel";
import { InboxPanel } from "@/components/InboxPanel";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { MinderConfig } from "@/lib/types";
import { getFlag } from "@/lib/featureFlags";

export default function Home() {
  useDocumentTitle("Dashboard");
  const { data, loading, rescan, archiveProject, unarchiveProject } = useProjects();
  const { statuses } = useGitDirtyStatus();
  const { grades } = useEfficiencyGrades();
  const [taskDispatcherEnabled, setTaskDispatcherEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: MinderConfig) => {
        setTaskDispatcherEnabled(getFlag(d.featureFlags, "taskDispatcher", false));
      })
      .catch(() => {});
  }, []);

  return (
    <>
      {taskDispatcherEnabled && (
        <>
          <DecisionsPanel />
          <InboxPanel />
        </>
      )}
      <DashboardGrid
        projects={data?.projects ?? []}
        loading={loading}
        onRescan={rescan}
        onArchive={archiveProject}
        onUnarchive={unarchiveProject}
        scannedAt={data?.scannedAt}
        gitDirtyOverrides={statuses}
        efficiencyGrades={grades}
      />
    </>
  );
}
