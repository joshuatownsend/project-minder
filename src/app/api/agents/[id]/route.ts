import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getAgentUsage } from "@/lib/data";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";
import { parseUsagePeriod } from "@/lib/usage/period";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import { demoMode } from "@/lib/demo/demoMode";
import { catalogHomeErrorResponse } from "@/lib/server/catalogHomeHttp";
import { demoAgentDetail } from "@/lib/demo/catalogs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const period = parseUsagePeriod(request.nextUrl.searchParams.get("period"));

  if (await demoMode()) {
    const detail = demoAgentDetail(id, Date.now());
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ entry: detail.entry, bodyFull: detail.bodyFull, usage: detail.usage, period });
  }

  // `home`: resolve the id inside another Claude home's catalog (#553). Usage
  // is joined for the primary home only — see `loadAgentsResponse`.
  const home = request.nextUrl.searchParams.get("home");
  let catalog;
  try {
    catalog = await loadCatalog({ includeProjects: true, home });
  } catch (err) {
    return catalogHomeErrorResponse(err);
  }
  const entry = catalog.agents.find((a) => a.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [bodyText, agentUsage] = await Promise.all([
    fs.readFile(entry.filePath, "utf-8").catch(() => ""),
    catalog.home.primary ? getAgentUsage(period) : null,
  ]);

  const aliasMap = buildAgentAliasMap(catalog.agents);
  const usage = agentUsage?.stats.find(
    (s) => aliasMap.get(s.name.toLowerCase()) === entry
  );

  const response = NextResponse.json({
    entry: withProjectedContextCost(entry),
    bodyFull: bodyText,
    usage,
    period,
  });
  response.headers.set("X-Minder-Backend", agentUsage?.meta.backend ?? "file");
  return response;
}
