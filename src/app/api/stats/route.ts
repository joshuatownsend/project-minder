import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { scanClaudeConversationsForProjects } from "@/lib/scanner/claudeConversations";
import { ClaudeUsageStats } from "@/lib/types";

const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

// globalThis singleton — survives Next.js module reloads
const globalForStats = globalThis as unknown as {
  __claudeUsageCache?: { usage: ClaudeUsageStats; cachedAt: number };
};

export async function GET() {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  // Fetch Claude usage stats scoped to scanned projects only
  let cache = globalForStats.__claudeUsageCache;
  if (!cache || Date.now() - cache.cachedAt > CLAUDE_USAGE_TTL) {
    const projectPaths = result.projects.map((p) => p.path);
    const usage = await scanClaudeConversationsForProjects(projectPaths);
    cache = { usage, cachedAt: Date.now() };
    globalForStats.__claudeUsageCache = cache;
  }

  const stats = computeStats(result.projects, result.hiddenCount, cache.usage);
  return NextResponse.json(stats);
}
