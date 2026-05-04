import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { buildHotFiles, type HotFilesResult } from "@/lib/usage/fileTracker";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import type { UsageTurn } from "@/lib/usage/types";

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\.]/g, "-");
}

interface HotFilesResponse {
  slug: string;
  result: HotFilesResult;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: HotFilesResponse;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForHotFiles = globalThis as unknown as {
  __hotFilesCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForHotFiles.__hotFilesCache) {
    globalForHotFiles.__hotFilesCache = new Map();
  }
  return globalForHotFiles.__hotFilesCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const cache = getCache();
  const cached = cache.get(slug);
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

  const result = buildHotFiles(projectTurns);
  const data: HotFilesResponse = { slug, result, generatedAt: new Date().toISOString() };
  cache.set(slug, { data, cachedAt: Date.now(), jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
