import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { InsightEntry } from "@/lib/types";

export async function GET(request: NextRequest) {
  const projectFilter = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase();

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

  // Sort latest-first
  insights.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });

  // Keyword search
  if (query) {
    insights = insights.filter((i) =>
      i.content.toLowerCase().includes(query)
    );
  }

  return NextResponse.json({ insights, total: insights.length });
}
