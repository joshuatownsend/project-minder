import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { detectWorkflowPatterns } from "@/lib/usage/workflowPatterns";
import type { WorkflowPattern } from "@/lib/usage/workflowPatterns";
import { loadCatalog } from "@/lib/indexer/catalog";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";

// Cross-session workflow pattern detection for a project. Cached with a 5-min
// TTL + jsonlMtime invalidation — same pattern as efficiency/hot-files routes.

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PatternsResponse {
  patterns: WorkflowPattern[];
  totalSessionsConsidered: number;
  totalBashCalls: number;
  meta: { cachedAt: number; jsonlMtime: number };
}

interface CacheSlot {
  data: PatternsResponse;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForPatterns = globalThis as unknown as {
  __patternsCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForPatterns.__patternsCache) {
    globalForPatterns.__patternsCache = new Map();
  }
  return globalForPatterns.__patternsCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const cache = getCache();
  const cached = cache.get(slug);
  const currentMtime = getJsonlMaxMtime();
  if (
    cached &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS &&
    cached.jsonlMtime === currentMtime
  ) {
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

  const [sessionMap, catalog] = await Promise.all([
    parseAllSessions(),
    loadCatalog({ includeProjects: true }),
  ]);

  const projectTurns = gatherProjectTurns(sessionMap, slug, project.path);
  const result = detectWorkflowPatterns({
    turns: projectTurns,
    skillsCatalog: catalog.skills.filter(
      (s) => !s.projectSlug || s.projectSlug === slug
    ),
  });

  const now = Date.now();
  const data: PatternsResponse = {
    ...result,
    meta: { cachedAt: now, jsonlMtime: currentMtime },
  };
  cache.set(slug, { data, cachedAt: now, jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
