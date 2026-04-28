import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateAgentsRouteCache } from "@/app/api/agents/route";
import { invalidateSkillsRouteCache } from "@/app/api/skills/route";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";

export async function POST() {
  invalidateCache();
  invalidateCatalogCache();
  invalidateAgentsRouteCache();
  invalidateSkillsRouteCache();
  invalidateClaudeConfigRouteCache();
  invalidateUserConfigCache();
  const result = await scanAllProjects();
  setCachedScan(result);
  return NextResponse.json(result);
}
