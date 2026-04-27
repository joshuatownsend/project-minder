import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateAgentsRouteCache } from "@/app/api/agents/route";
import { invalidateSkillsRouteCache } from "@/app/api/skills/route";

export async function POST() {
  invalidateCache();
  invalidateCatalogCache();
  invalidateAgentsRouteCache();
  invalidateSkillsRouteCache();
  const result = await scanAllProjects();
  setCachedScan(result);
  return NextResponse.json(result);
}
