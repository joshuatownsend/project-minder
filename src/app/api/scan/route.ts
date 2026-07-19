import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateAgentsRouteCache } from "@/app/api/agents/route";
import { invalidateSkillsRouteCache } from "@/app/api/skills/route";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";
import { invalidateLiveStatusCache } from "@/lib/liveStatus";
import { invalidateClaudeAgentsCache } from "@/lib/claudeAgentsCli";
import { runMcpSecurityScan } from "@/lib/scanner/mcp-security";
import { clearWslCache } from "@/lib/wsl";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { githubActivityCache } from "@/lib/githubActivityCache";

export async function POST() {
  invalidateCache();
  // Manual rescan is user-initiated: drop the cached WSL distro snapshot so a
  // just-started distro's root is scanned now, not skipped for the 30s TTL —
  // and purge the caches' stopped-WSL sentinels so dirty status and GitHub
  // activity for those projects are re-probed on the very next enqueue
  // instead of after their 5-minute TTL.
  clearWslCache();
  gitStatusCache.invalidateWslSentinels();
  githubActivityCache.invalidateWslSentinels();
  invalidateCatalogCache();
  invalidateAgentsRouteCache();
  invalidateSkillsRouteCache();
  invalidateClaudeConfigRouteCache();
  invalidateUserConfigCache();
  // Wave-T1.1: clear the live-status payload and inner `claude agents --json`
  // caches so manual rescan doesn't keep serving stale process listings for
  // up to 10 s (CLI cache) / 6 s (wrapping payload) after the user clicks.
  invalidateLiveStatusCache();
  invalidateClaudeAgentsCache();
  // Run the project scan and MCP security scan in parallel.
  const [result] = await Promise.all([
    scanAllProjects(),
    runMcpSecurityScan("scan").catch(() => null),
  ]);
  setCachedScan(result);
  return NextResponse.json(result);
}
