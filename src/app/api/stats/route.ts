import { NextRequest } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { getClaudeUsage } from "@/lib/data";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import { ClaudeUsageStats } from "@/lib/types";

const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

// globalThis singleton — survives Next.js module reloads. The slot includes
// the max JSONL mtime captured at refresh time so the ETag describes the
// bytes we serve, not the current filesystem state. `backend` is captured
// so served-from-cache responses keep reporting the same X-Minder-Backend
// header value the original computation produced.
const globalForStats = globalThis as unknown as {
  __claudeUsageCache?: {
    usage: ClaudeUsageStats;
    backend: "db" | "file";
    cachedAt: number;
    maxMtime: number;
  };
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
    // `getClaudeUsage` consults the SQLite index by default; the file-
    // parse fallback inside the façade still warms the JSONL FileCache
    // as a side effect when it fires, so `getJsonlMaxMtime()` remains
    // valid as the ETag input either way (DB path returns 0 from
    // `getJsonlMaxMtime` if no parser warm-up has happened, but the
    // ETag still rotates via `result.scannedAt`).
    const claudeUsage = await getClaudeUsage(projectPaths);
    cache = {
      usage: claudeUsage.stats,
      backend: claudeUsage.meta.backend,
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
  const response = jsonWithETag(stats, etag);
  response.headers.set("X-Minder-Backend", cache.backend);
  return response;
}
