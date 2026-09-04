import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getSkillUsage } from "@/lib/data";
import { buildSkillAliasMap } from "@/lib/indexer/canonicalize";
import { parseUsagePeriod } from "@/lib/usage/period";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import { demoMode } from "@/lib/demo/demoMode";
import { catalogHomeErrorResponse } from "@/lib/server/catalogHomeHttp";
import { demoSkillDetail } from "@/lib/demo/catalogs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const period = parseUsagePeriod(request.nextUrl.searchParams.get("period"));

  if (await demoMode()) {
    const detail = demoSkillDetail(id, Date.now());
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ entry: detail.entry, bodyFull: detail.bodyFull, usage: detail.usage, period });
  }

  // `home`: resolve the id inside another Claude home's catalog (#553). Usage
  // is joined for the primary home only — see `loadSkillsResponse`.
  const home = request.nextUrl.searchParams.get("home");
  let catalog;
  try {
    catalog = await loadCatalog({ includeProjects: true, home });
  } catch (err) {
    return catalogHomeErrorResponse(err);
  }
  const entry = catalog.skills.find((s) => s.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [bodyText, skillUsage] = await Promise.all([
    fs.readFile(entry.filePath, "utf-8").catch(() => ""),
    catalog.home.primary ? getSkillUsage(period) : null,
  ]);

  const aliasMap = buildSkillAliasMap(catalog.skills);
  const usage = skillUsage?.stats.find(
    (s) => aliasMap.get(s.name.toLowerCase()) === entry
  );

  const response = NextResponse.json({
    entry: withProjectedContextCost(entry),
    bodyFull: bodyText,
    usage,
    period,
  });
  response.headers.set("X-Minder-Backend", skillUsage?.meta.backend ?? "file");
  return response;
}
