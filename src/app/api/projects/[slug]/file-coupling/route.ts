import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { buildFileCoupling, type FileCouplingResult } from "@/lib/usage/fileCoupling";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { getOrCreateRouteCache } from "@/lib/routeCache";

interface FileCouplingResponse {
  slug: string;
  result: FileCouplingResult;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: FileCouplingResponse;
  jsonlMtime: number;
}

const cache = getOrCreateRouteCache<CacheSlot>("file-coupling", { ttlMs: CACHE_TTL_MS });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const raw = Number(request.nextUrl.searchParams.get("min") ?? "2");
  const minCoOccurrences = Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.trunc(raw))) : 2;

  try {
    // Cache key includes the threshold so changing ?min= yields fresh data.
    const cacheKey = `${slug}:${minCoOccurrences}`;
    const cached = cache.get(cacheKey);
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

    const sessionMap = await parseAllSessions();
    const projectTurns = gatherProjectTurns(sessionMap, slug, project.path);

    const result = buildFileCoupling(projectTurns, minCoOccurrences);
    const data: FileCouplingResponse = { slug, result, generatedAt: new Date().toISOString() };
    cache.set(cacheKey, { data, jsonlMtime: currentMtime });
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[file-coupling] Error processing slug="${slug}":`, err);
    return NextResponse.json({ error: "Failed to compute file coupling. Check server logs." }, { status: 500 });
  }
}
