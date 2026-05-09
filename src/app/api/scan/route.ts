import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateAgentsRouteCache } from "@/app/api/agents/route";
import { invalidateSkillsRouteCache } from "@/app/api/skills/route";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";
import { runMcpSecurityScan } from "@/lib/scanner/mcp-security";

export async function POST() {
  invalidateCache();
  invalidateCatalogCache();
  invalidateAgentsRouteCache();
  invalidateSkillsRouteCache();
  invalidateClaudeConfigRouteCache();
  invalidateUserConfigCache();
  // Run the project scan and MCP security scan in parallel.
  const [result] = await Promise.all([
    scanAllProjects(),
    runMcpSecurityScan("scan").catch(() => null),
  ]);
  setCachedScan(result);
  return NextResponse.json(result);
}
