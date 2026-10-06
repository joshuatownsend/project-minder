import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { enqueueProjectCaches } from "@/lib/projectCacheEnqueue";
import { readConfig } from "@/lib/config";
import { demoMode } from "@/lib/demo/demoMode";
import { withGroups } from "@/lib/groups/withGroups";

export async function GET() {
  const config = await readConfig();
  const flags = config.featureFlags;
  // Demo projects have fake C:\dev paths — never run real git/grade/github
  // checks against them (they'd return unknown/0 and overwrite the synthetic
  // dirty counts in the cached ProjectData). The demo activity strips are
  // served by the /api/git-status, /api/github-activity route guards instead.
  const isDemo = await demoMode();
  const cached = getCachedScan();

  if (cached) {
    if (!isDemo) enqueueProjectCaches(cached.projects, flags);
    return NextResponse.json(withGroups(cached, config));
  }

  // `scanAllProjects` already shares one in-flight scan per cache generation, so no
  // route-local guard here (it could keep joining a pre-invalidation scan). Serve the
  // result we awaited rather than re-reading the cache: `setCachedScan` refuses a
  // result whose scan was overtaken by an invalidation, and the cache would be empty.
  const result = await scanAllProjects();
  // Serve what we awaited, but only warm caches from a result the cache accepted (or the newer
  // one that replaced it): an overtaken scan's paths would be deduped-in by slug for the TTL.
  const warmFrom = setCachedScan(result) ? result : getCachedScan();
  if (!isDemo && warmFrom) enqueueProjectCaches(warmFrom.projects, flags);
  return NextResponse.json(withGroups(result, config));
}
