import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getSkillUsage } from "@/lib/data";
import { buildSkillAliasMap } from "@/lib/indexer/canonicalize";
import { parseUsagePeriod } from "@/lib/usage/period";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import { demoMode } from "@/lib/demo/demoMode";
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

  const catalog = await loadCatalog({ includeProjects: true });
  const entry = catalog.skills.find((s) => s.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [bodyText, skillUsage] = await Promise.all([
    fs.readFile(entry.filePath, "utf-8").catch(() => ""),
    getSkillUsage(period),
  ]);

  const aliasMap = buildSkillAliasMap(catalog.skills);
  const usage = skillUsage.stats.find(
    (s) => aliasMap.get(s.name.toLowerCase()) === entry
  );

  const response = NextResponse.json({
    entry: withProjectedContextCost(entry),
    bodyFull: bodyText,
    usage,
    period,
  });
  response.headers.set("X-Minder-Backend", skillUsage.meta.backend);
  return response;
}
