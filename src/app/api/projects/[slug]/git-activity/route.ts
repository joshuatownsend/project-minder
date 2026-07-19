import { NextRequest, NextResponse } from "next/server";
import type { GitActivitySummary } from "@/lib/usage/gitActivity";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { getProjectGitActivity } from "@/lib/projectGitActivity";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { wslGuardResponse } from "@/lib/wslRouteGuard";

interface GitActivityResponse {
  slug: string;
  activity: GitActivitySummary;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: GitActivityResponse;
  jsonlMtime: number;
}

const cache = getOrCreateRouteCache<CacheSlot>("git-activity", { ttlMs: CACHE_TTL_MS });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    const cached = cache.get(slug);
    const currentMtime = getJsonlMaxMtime();
    if (cached && cached.jsonlMtime === currentMtime) {
      return NextResponse.json(cached.data);
    }

    let scan = getCachedScan();
    if (!scan) {
      scan = await scanAllProjects();
      setCachedScan(scan);
    }
    const project = scan.projects.find((p) => p.slug === slug);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Never-wake preflight: git-log activity spawns git with cwd on the
    // project path — blocked while its WSL distro is stopped.
    const wslResp = await wslGuardResponse(project.path);
    if (wslResp) return wslResp;

    const activity = await getProjectGitActivity(slug, project.path);
    const data: GitActivityResponse = { slug, activity, generatedAt: new Date().toISOString() };
    cache.set(slug, { data, jsonlMtime: currentMtime });
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[git-activity] Error processing slug="${slug}":`, err);
    return NextResponse.json({ error: "Failed to compute git activity." }, { status: 500 });
  }
}
