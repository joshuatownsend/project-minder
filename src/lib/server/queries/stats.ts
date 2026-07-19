import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { computeStats } from "@/lib/stats";
import { getClaudeUsage, getSessionsList } from "@/lib/data";
import { demoMode } from "@/lib/demo/demoMode";
import {
  getStatsCache,
  crossCheckStats,
} from "@/lib/scanner/claudeStats";
import { projectScatter } from "@/lib/usage/sessionScatter";
import type { ClaudeUsageStats } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared stats inputs + response assembly, used by BOTH `/api/stats` (client
 * fetch) and the RSC prefetch (`prefetchStats`). The route keeps its ETag
 * computation (it needs the cached usage watermark); everything that shapes the
 * response *body* lives here so the prefetched cache entry is byte-identical to
 * what `fetch('/api/stats')` returns.
 */

const CLAUDE_USAGE_TTL = 10 * 60_000; // 10 minutes

// globalThis singleton — survives Next.js module reloads, shared by the route
// and the RSC prefetch. Mirrors the slot the route previously owned inline.
const globalForStats = globalThis as unknown as {
  __claudeUsageCache?: {
    usage: ClaudeUsageStats;
    backend: "db" | "file";
    cachedAt: number;
    maxMtime: number;
    demo: boolean;
  };
};

/** Drop the cached Claude-usage slot. Called by PATCH /api/config when
 *  claudeHomes/pathMappings change — the sweep the slot was built from
 *  depended on the old homes, and its 10-min TTL would otherwise keep
 *  serving the pre-save portfolio numbers. */
export function invalidateClaudeUsageCache(): void {
  globalForStats.__claudeUsageCache = undefined;
}

export interface StatsInputs {
  result: Awaited<ReturnType<typeof scanAllProjects>>;
  usage: ClaudeUsageStats;
  backend: "db" | "file";
  /** Claude-usage content watermark — feeds the route's ETag. */
  maxMtime: number;
}

/** Warm (if stale) the scan + claude-usage caches and return the stats inputs. */
export async function getStatsInputs(): Promise<StatsInputs> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  // Salt by demo state: toggling the demoMode flag switches project sets, so a
  // slot built in the other mode would show mixed real/synthetic usage for the
  // 10-min TTL.
  const demo = await demoMode();
  let cache = globalForStats.__claudeUsageCache;
  if (!cache || cache.demo !== demo || Date.now() - cache.cachedAt > CLAUDE_USAGE_TTL) {
    const projectPaths = result.projects.map((p) => p.path);
    const claudeUsage = await getClaudeUsage(projectPaths);
    cache = {
      usage: claudeUsage.stats,
      backend: claudeUsage.meta.backend,
      cachedAt: Date.now(),
      maxMtime: claudeUsage.meta.maxMtimeMs,
      demo,
    };
    globalForStats.__claudeUsageCache = cache;
  }

  return { result, usage: cache.usage, backend: cache.backend, maxMtime: cache.maxMtime };
}

/**
 * Assemble the full `/api/stats` response body: portfolio stats + per-project
 * session scatter + the cross-check against Claude Code's own stats-cache.json.
 */
export async function buildStatsResponse(inputs: StatsInputs) {
  const { result, usage } = inputs;
  const stats = computeStats(
    result.projects,
    result.hiddenCount,
    usage,
    result.catalogLintFindings,
  );

  // Sessions list (scatter + message-count cross-check) and Claude's own
  // stats-cache are independent — fetch concurrently. Both are cached, so cheap.
  const [sessionsList, statsCache] = await Promise.all([
    getSessionsList().catch(() => null), // non-fatal — scatter just shows empty
    getStatsCache(),
  ]);

  const sessions: ReturnType<typeof projectScatter>[] =
    sessionsList?.sessions.map(projectScatter) ?? [];

  // Cross-check our computed totals against Claude Code's stats-cache.json.
  // messages is summed from the sessions list; when that fetch failed we report
  // null rather than a misleading 0 (which would show a huge negative drift).
  const observedMessages = sessionsList
    ? sessionsList.sessions.reduce((sum, s) => sum + (s.messageCount ?? 0), 0)
    : null;
  const crossCheck = crossCheckStats(statsCache, {
    sessions: stats.claudeSessions.total,
    messages: observedMessages,
  });

  return { ...stats, sessions, crossCheck };
}

/** Prefetch the stats page's single query (`["stats"]`). */
export async function prefetchStats(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.stats(),
    queryFn: async () => {
      const inputs = await getStatsInputs();
      return jsonClone(await buildStatsResponse(inputs));
    },
  });
}
