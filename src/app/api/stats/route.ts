import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { scanClaudeConversationsForProjects } from "@/lib/scanner/claudeConversations";
import { ClaudeUsageStats } from "@/lib/types";

// Cache Claude usage stats separately (expensive to compute)
let cachedClaudeUsage: ClaudeUsageStats | null = null;
let claudeUsageCachedAt = 0;
const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

export async function GET() {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  // Fetch Claude usage stats scoped to scanned projects only
  let claudeUsage = cachedClaudeUsage;
  if (!claudeUsage || Date.now() - claudeUsageCachedAt > CLAUDE_USAGE_TTL) {
    const projectPaths = result.projects.map((p) => p.path);
    claudeUsage = await scanClaudeConversationsForProjects(projectPaths);
    cachedClaudeUsage = claudeUsage;
    claudeUsageCachedAt = Date.now();
  }

  const stats = computeStats(result.projects, result.hiddenCount, claudeUsage);
  return NextResponse.json(stats);
}
