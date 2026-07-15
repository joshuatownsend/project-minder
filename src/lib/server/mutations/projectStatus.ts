import "server-only";
import { mutateConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { demoMode } from "@/lib/demo/demoMode";
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
  // Demo mode is read-only: never persist a synthetic project's status into
  // .minder.json (the demo slug could later collide with a real project of the
  // same name). No-op covers both the config PUT status branch and the
  // setProjectStatusAction Server Action, which both funnel through here, while
  // leaving the rest of config PUT (flags, hidden, …) — including the demoMode
  // toggle itself — writable.
  if (await demoMode()) return;
  await mutateConfig((config) => {
    config.statuses[slug] = status;
  });
  invalidateCache();
  invalidateClaudeConfigRouteCache();
}
