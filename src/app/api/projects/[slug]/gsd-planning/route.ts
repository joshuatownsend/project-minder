import { NextRequest, NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { getSessionCostsInWindow } from "@/lib/data";
import type { GsdPlanningInfo } from "@/lib/types";

const globalForGsd = globalThis as unknown as {
  __gsdPlanningCache?: Map<string, { data: GsdPlanningInfo; cachedAt: number }>;
};
const TTL_MS = 5 * 60_000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;

  const cached = globalForGsd.__gsdPlanningCache?.get(slug);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) {
    return NextResponse.json(cached.data);
  }

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const project = result.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!project.gsdPlanning) return NextResponse.json({ error: "no planning data" }, { status: 404 });

  // Enrich phases with cost data from session DB (only when timestamps present)
  const info: GsdPlanningInfo = {
    ...project.gsdPlanning,
    phases: await Promise.all(
      project.gsdPlanning.phases.map(async (phase) => {
        if (!phase.startedAt || !phase.endedAt) return phase;
        const startMs = new Date(phase.startedAt).getTime();
        const endMs = new Date(phase.endedAt).getTime();
        if (isNaN(startMs) || isNaN(endMs)) return phase;
        const rows = await getSessionCostsInWindow(slug, startMs, endMs);
        const costUsd = rows.reduce((s, r) => s + r.costUsd, 0);
        return { ...phase, costUsd: rows.length > 0 ? costUsd : undefined };
      }),
    ),
  };

  if (!globalForGsd.__gsdPlanningCache) {
    globalForGsd.__gsdPlanningCache = new Map();
  }
  globalForGsd.__gsdPlanningCache.set(slug, { data: info, cachedAt: Date.now() });

  return NextResponse.json(info);
}
