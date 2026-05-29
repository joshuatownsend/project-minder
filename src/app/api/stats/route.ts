import { NextRequest } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { getClaudeUsage, getSessionsList } from "@/lib/data";
import { getStatsCache, crossCheckStats } from "@/lib/scanner/claudeStats";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import { ClaudeUsageStats } from "@/lib/types";
import { projectScatter } from "@/lib/usage/sessionScatter";

const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

// globalThis singleton — survives Next.js module reloads. The slot includes
// the max content-mtime watermark captured at refresh time (from the
// façade's meta — DB path uses `MAX(file_mtime_ms) FROM sessions`, file
// path returns 0) so the ETag describes the bytes we serve, not the
// current filesystem state. `backend` is captured so served-from-cache
// responses keep reporting the same X-Minder-Backend header value the
// original computation produced.
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
    const claudeUsage = await getClaudeUsage(projectPaths);
    cache = {
      usage: claudeUsage.stats,
      backend: claudeUsage.meta.backend,
      cachedAt: Date.now(),
      maxMtime: claudeUsage.meta.maxMtimeMs,
    };
    globalForStats.__claudeUsageCache = cache;
  }

  // ETag inputs:
  //   - `salt` includes the backend label so a runtime swap (DB <-> file,
  //     e.g. after the cached `ensureSchemaReady` flips) rotates the
  //     ETag and clients re-fetch instead of being 304'd against bytes
  //     that may carry a different `costEstimate` (DB pricing is
  //     per-turn-accurate; file-parse falls back to sonnet pricing for
  //     cache-only files).
  //   - `maxMtimeMs` combines content freshness (`cache.maxMtime`,
  //     populated from the façade — fresh under DB, 0 under file) with
  //     scan freshness (`result.scannedAt`). Under file backend the 0
  //     means scan freshness alone drives the ETag; that's adequate
  //     because the route's 10-min cache rotates `cachedAt` and the
  //     scan rotates on its own cycle.
  const etag = computeETag({
    salt: `stats-v2-${cache.backend}`,
    maxMtimeMs: Math.max(cache.maxMtime, new Date(result.scannedAt).getTime()),
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  const stats = computeStats(result.projects, result.hiddenCount, cache.usage, result.catalogLintFindings);

  // Sessions list (for the scatter chart + the message-count cross-check) and
  // Claude's own stats-cache are independent — fetch concurrently. Both are
  // cached (sessions: 2-min; stats-cache: by mtime), so this is cheap.
  const [sessionsList, statsCache] = await Promise.all([
    getSessionsList().catch(() => null), // non-fatal — scatter just shows empty
    getStatsCache(),
  ]);

  const sessions: ReturnType<typeof projectScatter>[] =
    sessionsList?.sessions.map(projectScatter) ?? [];

  // Cross-check our computed totals against Claude Code's own stats-cache.json
  // (diagnostic; degrades to available:false when the file is absent). Both
  // rows compare like-for-like counts: sessions vs sessions, and our summed
  // per-session message count vs Claude's message tally.
  const observedMessages =
    sessionsList?.sessions.reduce((sum, s) => sum + (s.messageCount ?? 0), 0) ?? 0;
  const crossCheck = crossCheckStats(statsCache, {
    sessions: stats.claudeSessions.total,
    messages: observedMessages,
  });

  const response = jsonWithETag({ ...stats, sessions, crossCheck }, etag);
  response.headers.set("X-Minder-Backend", cache.backend);
  return response;
}
