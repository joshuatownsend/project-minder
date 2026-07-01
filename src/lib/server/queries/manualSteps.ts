import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import type { ManualStepsInfo } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/** One project's manual-steps summary from `/api/manual-steps`. */
export interface ProjectManualSteps {
  slug: string;
  name: string;
  path: string;
  manualSteps: ManualStepsInfo;
}

/**
 * Shared `/api/manual-steps` response computation, used by both the route and
 * the RSC prefetch. Collects every project that has a MANUAL_STEPS.md from the
 * scan cache and, when `pendingOnly` is set, narrows to those with outstanding
 * steps.
 *
 * The `manualStepsWatcher.init()` side effect is intentionally preserved from
 * the original route: it starts the file watcher that backs the manual-steps
 * change-notification stream, so the watcher must be running whenever this list
 * is read (route GET *or* RSC prefetch).
 */
export async function loadManualStepsResponse(
  pendingOnly = false,
): Promise<ProjectManualSteps[]> {
  // Ensure watcher is running for change detection.
  await manualStepsWatcher.init();

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const projects: ProjectManualSteps[] = result.projects
    .filter((p) => p.manualSteps)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      path: p.path,
      manualSteps: p.manualSteps!,
    }));

  if (pendingOnly) {
    return projects.filter((p) => p.manualSteps.pendingSteps > 0);
  }

  return projects;
}

/** Prefetch the default (unfiltered) cross-project manual-steps list. */
export async function prefetchManualSteps(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.manualSteps(),
    queryFn: async () => jsonClone(await loadManualStepsResponse(false)),
  });
}
