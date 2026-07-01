import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import type { InsightEntry } from "@/lib/types";
import type { AllInsightsResult } from "@/lib/queryOptions";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared `/api/insights` response computation, used by both the route and the
 * RSC prefetch. Collects per-project INSIGHTS.md entries from the scan cache,
 * sorts latest-first, and applies the optional project/keyword filters.
 */
export async function loadInsightsResponse(
  projectFilter: string | null,
  query: string | null,
): Promise<AllInsightsResult> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  let insights: InsightEntry[] = [];
  for (const p of result.projects) {
    if (projectFilter && p.slug !== projectFilter) continue;
    if (p.insights) {
      insights.push(...p.insights.entries);
    }
  }

  // Sort latest-first.
  insights.sort((a, b) => {
    const ta = new Date(a.date).getTime() || 0;
    const tb = new Date(b.date).getTime() || 0;
    return tb - ta;
  });

  // Keyword search.
  const q = query?.toLowerCase() ?? null;
  if (q) {
    insights = insights.filter((i) => i.content.toLowerCase().includes(q));
  }

  return { insights, total: insights.length };
}

/** Prefetch the default (unfiltered) cross-project insights list. */
export async function prefetchInsights(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.insights.all(),
    queryFn: async () => jsonClone(await loadInsightsResponse(null, null)),
  });
}
