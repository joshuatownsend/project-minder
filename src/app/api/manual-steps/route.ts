import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";

export async function GET(request: NextRequest) {
  // Ensure watcher is running for change detection
  await manualStepsWatcher.init();
  const pendingOnly = request.nextUrl.searchParams.get("pending") === "true";

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const projects = result.projects
    .filter((p) => p.manualSteps)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      path: p.path,
      manualSteps: p.manualSteps!,
    }));

  if (pendingOnly) {
    return NextResponse.json(
      projects.filter((p) => p.manualSteps.pendingSteps > 0)
    );
  }

  return NextResponse.json(projects);
}
