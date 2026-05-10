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

/**
 * Projects dashboard. Was the app's `/` until the Claudoscope redesign moved
 * the new Home Overview to `/`. The card grid + filters live entirely in
 * `<DashboardGrid>` — this page just wires data hooks.
 */
export default function ProjectsPage() {
  useDocumentTitle("Projects");
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
    <div className="shell-content wide">
      {taskDispatcherEnabled && <DecisionsPanel />}
      {taskDispatcherEnabled && <InboxPanel />}
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
    </div>
  );
}
