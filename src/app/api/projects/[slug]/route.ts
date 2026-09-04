import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanGitDirtyStatus } from "@/lib/scanner/git";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { demoMode } from "@/lib/demo/demoMode";
import { checkWslRoot, parseWslUncPath } from "@/lib/wsl";
import { groupForProject } from "@/lib/groups/forProject";
import type { ProjectResponse } from "@/lib/types";

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

  // The group this project belongs to, derived exactly as `withGroups` does
  // for the list route (same scan, same opt-out list), so the member page's
  // link agrees with the dashboard chip. Computed above the demo return: the
  // demo scan seeds a group too. Spread onto a NEW object rather than assigned
  // to the cached project — `project.git` below is already mutated in place,
  // and a second in-place attachment would leave `group` on the shared cache.
  const config = await readConfig();
  const group = groupForProject(result.projects, project.slug, {
    ungroupedPaths: config.ungroupedPaths,
  });
  const respond = (p: typeof project): NextResponse =>
    NextResponse.json({ ...p, ...(group ? { group } : {}) } satisfies ProjectResponse);

  // Demo project: fake C:\dev path — return the synthetic ProjectData as-is
  // (live git/github checks would overwrite its dirty count with unknown/0 and
  // poison the cached scan). The activity strips are served by their own guards.
  if (await demoMode()) {
    return respond(project);
  }

  // Never-wake preflight: a carried-forward project under a stopped WSL
  // distro must not be probed with git — the spawn's cwd on \\wsl.localhost
  // would auto-start the VM. Keep the carried (last-good) counts and mark
  // them unknown instead. Sync-parse first so non-WSL paths skip the lookup.
  const wslBlocked = parseWslUncPath(project.path)
    ? await checkWslRoot(project.path).then((c) => c !== null && !c.ok)
    : false;

  // Enrich with live git dirty status (too slow for bulk scan)
  if (project.git && wslBlocked) {
    project.git.unknown = true;
  } else if (project.git) {
    const dirty = await scanGitDirtyStatus(project.path);
    project.git.isDirty = dirty.isDirty;
    project.git.uncommittedCount = dirty.uncommittedCount;
    // Surface a failed git check as unknown, not as a confirmed-clean repo.
    project.git.unknown = dirty.unknown;
    // Update background cache so it doesn't re-check this project
    gitStatusCache.set(project.slug, dirty.isDirty, dirty.uncommittedCount, dirty.unknown);
  }

  // GitHub activity (Portfolio Command Deck — Phase 4): default-on. The LIST
  // route enqueues on dashboard load, but opening /project/<slug> directly only
  // hits this route — without this the cache stays empty and the activity strip
  // never appears. Mirror the list route: flag-gated, git-tracked only, carry
  // the scanned remote, skip if a fresh cache entry already exists.
  if (project.git && githubActivityCache.get(project.slug) == null) {
    if (getFlag(config.featureFlags, "githubActivity")) {
      githubActivityCache.enqueue([
        { slug: project.slug, path: project.path, remoteUrl: project.git.remoteUrl },
      ]);
    }
  }

  return respond(project);
}
