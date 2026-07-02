import "server-only";
import { mutateConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import type { ProjectStatus } from "@/lib/types";

/**
 * Core project-status write: persist `statuses[slug] = status` in `.minder.json`
 * and invalidate the scan + claude-config route caches so the next read
 * reflects it.
 *
 * Single source of truth for both the PUT /api/config `{slug, status}` branch
 * and the `setProjectStatusAction` Server Action. Mirrors the route's
 * `invalidateAll()` (scan cache + claude-config route cache) exactly so the two
 * paths stay behaviourally identical.
 */
export async function setProjectStatus(
  slug: string,
  status: ProjectStatus,
): Promise<void> {
  await mutateConfig((config) => {
    config.statuses[slug] = status;
  });
  invalidateCache();
  invalidateClaudeConfigRouteCache();
}
