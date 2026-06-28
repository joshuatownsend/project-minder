import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanGitDirtyStatus } from "@/lib/scanner/git";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";

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

  // GitHub activity (Portfolio Command Deck — Phase 4): default-on. The LIST
  // route enqueues on dashboard load, but opening /project/<slug> directly only
  // hits this route — without this the cache stays empty and the activity strip
  // never appears. Mirror the list route: flag-gated, git-tracked only, carry
  // the scanned remote, skip if a fresh cache entry already exists.
  if (project.git && githubActivityCache.get(project.slug) == null) {
    const flags = (await readConfig()).featureFlags;
    if (getFlag(flags, "githubActivity")) {
      githubActivityCache.enqueue([
        { slug: project.slug, path: project.path, remoteUrl: project.git.remoteUrl },
      ]);
    }
  }

  return NextResponse.json(project);
}
