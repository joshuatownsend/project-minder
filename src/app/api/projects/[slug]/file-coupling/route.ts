import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { buildFileCoupling, type FileCouplingResult } from "@/lib/usage/fileCoupling";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import type { UsageTurn } from "@/lib/usage/types";

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\.]/g, "-");
}

interface FileCouplingResponse {
  slug: string;
  result: FileCouplingResult;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: FileCouplingResponse;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForFileCoupling = globalThis as unknown as {
  __fileCouplingCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForFileCoupling.__fileCouplingCache) {
    globalForFileCoupling.__fileCouplingCache = new Map();
  }
  return globalForFileCoupling.__fileCouplingCache;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const minCoOccurrences = Number(request.nextUrl.searchParams.get("min") ?? "2");

  // Cache key includes the threshold so changing the query param yields fresh data.
  const cacheKey = `${slug}:${minCoOccurrences}`;
  const cache = getCache();
  const cached = cache.get(cacheKey);
  const currentMtime = getJsonlMaxMtime();
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS && cached.jsonlMtime === currentMtime) {
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
  const expectedDirName = encodeProjectPath(project.path);
  const projectTurns: UsageTurn[] = [];
  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    if (head.projectSlug !== slug && head.projectDirName !== expectedDirName) continue;
    for (const t of turns) projectTurns.push(t);
  }

  const result = buildFileCoupling(projectTurns, minCoOccurrences);
  const data: FileCouplingResponse = { slug, result, generatedAt: new Date().toISOString() };
  cache.set(cacheKey, { data, cachedAt: Date.now(), jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
