import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { detectWorkflowPatterns } from "@/lib/usage/workflowPatterns";
import type { WorkflowPattern } from "@/lib/usage/workflowPatterns";
import { loadCatalog } from "@/lib/indexer/catalog";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { readConfig } from "@/lib/config";
import { getClaudeHomes } from "@/lib/claudeHome";
import { getOrCreateRouteCache } from "@/lib/routeCache";

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
  jsonlMtime: number;
  /** JSON of config.pathMappings at compute time — a Settings save that
   *  changes the mappings must invalidate (turn matching depends on them). */
  mappingsSig: string;
}

const cache = getOrCreateRouteCache<CacheSlot>("patterns", { ttlMs: CACHE_TTL_MS });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const cfg = await readConfig();
  const pathMappings = cfg.pathMappings ?? [];
  // Homes ride in the signature too: removing/adding a Claude home changes
  // the turn sweep even when the mappings are untouched.
  const mappingsSig = JSON.stringify([cfg.claudeHomes ?? [], pathMappings]);
  const cached = cache.get(slug);
  const currentMtime = getJsonlMaxMtime();
  if (cached && cached.jsonlMtime === currentMtime && cached.mappingsSig === mappingsSig) {
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

  const projectTurns = gatherProjectTurns(sessionMap, slug, project.path, pathMappings, getClaudeHomes(cfg));
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
  cache.set(slug, { data, jsonlMtime: currentMtime, mappingsSig });
  return NextResponse.json(data);
}
