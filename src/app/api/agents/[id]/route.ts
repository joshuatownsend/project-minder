import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getAgentUsage } from "@/lib/data";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";
import { parseUsagePeriod } from "@/lib/usage/period";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const period = parseUsagePeriod(request.nextUrl.searchParams.get("period"));

  const catalog = await loadCatalog({ includeProjects: true });
  const entry = catalog.agents.find((a) => a.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [bodyText, agentUsage] = await Promise.all([
    fs.readFile(entry.filePath, "utf-8").catch(() => ""),
    getAgentUsage(period),
  ]);

  const aliasMap = buildAgentAliasMap(catalog.agents);
  const usage = agentUsage.stats.find(
    (s) => aliasMap.get(s.name.toLowerCase()) === entry
  );

  const response = NextResponse.json({
    entry: withProjectedContextCost(entry),
    bodyFull: bodyText,
    usage,
    period,
  });
  response.headers.set("X-Minder-Backend", agentUsage.meta.backend);
  return response;
}
