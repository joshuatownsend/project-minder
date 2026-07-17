import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { enqueueProjectCaches } from "@/lib/projectCacheEnqueue";
import { readConfig } from "@/lib/config";
import { demoMode } from "@/lib/demo/demoMode";

let scanInProgress: Promise<void> | null = null;

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
    return NextResponse.json(cached);
  }

  // Prevent multiple concurrent scans
  if (!scanInProgress) {
    scanInProgress = scanAllProjects()
      .then((result) => {
        setCachedScan(result);
      })
      .finally(() => {
        scanInProgress = null;
      });
  }

  await scanInProgress;

  const result = getCachedScan();
  if (result) {
    if (!isDemo) enqueueProjectCaches(result.projects, flags);
    return NextResponse.json(result);
  }

  return NextResponse.json(
    { projects: [], portConflicts: [], hiddenCount: 0, scannedAt: new Date().toISOString() }
  );
}
