import { NextRequest } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { scanClaudeConversationsForProjects } from "@/lib/scanner/claudeConversations";
import { getJsonlMaxMtime, parseAllSessions } from "@/lib/usage/parser";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import { ClaudeUsageStats } from "@/lib/types";

const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

// globalThis singleton — survives Next.js module reloads. The slot includes
// the max JSONL mtime captured at refresh time so the ETag describes the
// bytes we serve, not the current filesystem state.
const globalForStats = globalThis as unknown as {
  __claudeUsageCache?: { usage: ClaudeUsageStats; cachedAt: number; maxMtime: number };
};

export async function GET(request: NextRequest) {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  let cache = globalForStats.__claudeUsageCache;
  if (!cache || Date.now() - cache.cachedAt > CLAUDE_USAGE_TTL) {
    const projectPaths = result.projects.map((p) => p.path);
    // parseAllSessions populates the FileCache so getJsonlMaxMtime() reflects
    // every JSONL we just considered. Snapshot it into the cache slot.
    await parseAllSessions();
    const usage = await scanClaudeConversationsForProjects(projectPaths);
    cache = {
      usage,
      cachedAt: Date.now(),
      maxMtime: getJsonlMaxMtime(),
    };
    globalForStats.__claudeUsageCache = cache;
  }

  // ETag combines scan freshness + JSONL freshness as captured at last refresh.
  const etag = computeETag({
    salt: "stats-v1",
    maxMtimeMs: Math.max(cache.maxMtime, new Date(result.scannedAt).getTime()),
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  const stats = computeStats(result.projects, result.hiddenCount, cache.usage);
  return jsonWithETag(stats, etag);
}
