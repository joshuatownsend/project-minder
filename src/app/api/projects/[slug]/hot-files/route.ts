import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { buildHotFiles, buildHotFilesFromEdits, type HotFilesResult } from "@/lib/usage/fileTracker";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { readConfig } from "@/lib/config";
import { loadProjectFileEdits } from "@/lib/data";
import { getClaudeHomes } from "@/lib/claudeHome";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { getOrCreateRouteCache } from "@/lib/routeCache";

interface HotFilesResponse {
  slug: string;
  result: HotFilesResult;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: HotFilesResponse;
  jsonlMtime: number;
  /** JSON of config.pathMappings at compute time — a Settings save that
   *  changes the mappings must invalidate (turn matching depends on them). */
  mappingsSig: string;
  /**
   * Which path produced `data`. Cached so `X-Minder-Backend` survives a cache
   * HIT — otherwise the header is present only on the first request and absent
   * on the common path, which is exactly where a caller still needs to tell an
   * indexed result from a file fallback (Codex, PR #454).
   */
  backend: "db" | "file";
}

const cache = getOrCreateRouteCache<CacheSlot>("hot-files", { ttlMs: CACHE_TTL_MS });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    const cfg = await readConfig();
    const pathMappings = cfg.pathMappings ?? [];
    // Homes ride in the signature too: removing/adding a Claude home changes
    // the turn sweep even when the mappings are untouched.
    const mappingsSig = JSON.stringify([cfg.claudeHomes ?? [], pathMappings]);
    const cached = cache.get(slug);
    const currentMtime = getJsonlMaxMtime();
    if (cached && cached.jsonlMtime === currentMtime && cached.mappingsSig === mappingsSig) {
      return NextResponse.json(cached.data, {
        headers: { "X-Minder-Backend": cached.backend },
      });
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

    // Index first. The JSONL path parses EVERY session in the portfolio and
    // then filters to this one project, so its cost scales with total history
    // rather than with what is being viewed — measured cold at 190s
    // (hot-files) and 299s (file-coupling) for payloads of 9 KB and 16 KB.
    // `loadProjectFileEdits` returns null, never [], when the index cannot
    // serve the answer, so an empty project stays distinguishable from an
    // unavailable backend (#439).
    const dbEdits = await loadProjectFileEdits({
      slug,
      projectPath: project.path,
      mappings: pathMappings,
      homes: getClaudeHomes(cfg),
    });

    const backend = dbEdits ? "db" : "file";
    // Annotated rather than left to `let result;`, which TypeScript widens
    // through control flow but which states nothing about the contract the two
    // branches share (Copilot, PR #454).
    let result: HotFilesResult;
    if (dbEdits) {
      result = buildHotFilesFromEdits(dbEdits);
    } else {
      const sessionMap = await parseAllSessions();
      const projectTurns = gatherProjectTurns(sessionMap, slug, project.path, pathMappings, getClaudeHomes(cfg));
      result = buildHotFiles(projectTurns);
    }
    const data: HotFilesResponse = { slug, result, generatedAt: new Date().toISOString() };
    cache.set(slug, { data, jsonlMtime: currentMtime, mappingsSig, backend });
    // Which path served this — the same `X-Minder-Backend` convention
    // `/api/sessions/search` uses. Without it, "is the index actually
    // being used?" is only answerable by timing, which is exactly how a
    // silent fallback stays invisible (#439).
    return NextResponse.json(data, { headers: { "X-Minder-Backend": backend } });
  } catch (err) {
    console.error(`[hot-files] Error processing slug="${slug}":`, err);
    return NextResponse.json({ error: "Failed to compute file activity. Check server logs." }, { status: 500 });
  }
}
