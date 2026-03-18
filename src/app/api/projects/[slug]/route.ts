import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanGitDirtyStatus } from "@/lib/scanner/git";
import { gitStatusCache } from "@/lib/gitStatusCache";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const project = result.projects.find((p) => p.slug === slug);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Enrich with live git dirty status (too slow for bulk scan)
  if (project.git) {
    const dirty = await scanGitDirtyStatus(project.path);
    project.git.isDirty = dirty.isDirty;
    project.git.uncommittedCount = dirty.uncommittedCount;
    // Update background cache so it doesn't re-check this project
    gitStatusCache.set(project.slug, dirty.isDirty, dirty.uncommittedCount);
  }

  return NextResponse.json(project);
}
