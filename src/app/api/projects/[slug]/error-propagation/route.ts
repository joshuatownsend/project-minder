import { NextRequest, NextResponse } from "next/server";
import { buildErrorPropagation, type ErrorReport } from "@/lib/usage/errorPropagation";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: ErrorReport;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForError = globalThis as unknown as {
  __errorPropagationCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForError.__errorPropagationCache) {
    globalForError.__errorPropagationCache = new Map();
  }
  return globalForError.__errorPropagationCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const cache = getCache();
    const currentMtime = getJsonlMaxMtime();
    const cached = cache.get(slug);
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

    const data = await buildErrorPropagation(project.path);
    cache.set(slug, { data, cachedAt: Date.now(), jsonlMtime: currentMtime });
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[error-propagation] slug="${slug}":`, err);
    return NextResponse.json(
      { error: "Failed to compute error propagation. Check server logs." },
      { status: 500 }
    );
  }
}
