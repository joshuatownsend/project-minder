import { getFlag } from "@/lib/featureFlags";
import { getUserConfig } from "@/lib/userConfigCache";
import { mcpHealthCache } from "@/lib/mcpHealthCache";
import type { MinderConfig, McpServer } from "@/lib/types";

/**
 * Shared enqueue logic for the MCP health cache. Extracted from
 * `GET /api/mcp-health` (Copilot follow-up on service-mode A1) so boot-time
 * bootstrap (`src/lib/bootstrap.ts`) warms the cache in the SAME stdio-probe
 * mode the route uses, instead of always booting in launchability mode and
 * only picking up an enabled `mcpHealthStdioProbe` flag on the first route
 * poll (which flips the mode and disposes/re-probes the whole cache — the
 * exact double-work this warm-up exists to avoid). Same idiom as
 * `projectCacheEnqueue.ts`'s `enqueueProjectCaches`: one enqueue rule, two
 * call sites, kept in lockstep by construction.
 *
 * Applies `mcpHealthStdioProbe` via `setStdioHandshake()` (a no-op if the mode
 * hasn't changed since the last call — it only clears/re-probes on a real
 * flip), pulls the merged user-scope MCP server list, and enqueues it.
 * `enqueue()` dedupes against its own TTL cache and in-flight `seen` set, so
 * this is safe to call unconditionally on every boot or poll.
 *
 * Returns the configured server list so callers that need it for further
 * filtering (the route's `configuredIds` set) don't have to re-fetch it.
 * Defensive: a missing/broken config source must never throw — it degrades
 * to an empty list, matching the route's pre-extraction try/catch.
 */
export async function enqueueMcpHealth(
  flags: MinderConfig["featureFlags"]
): Promise<McpServer[]> {
  mcpHealthCache.setStdioHandshake(getFlag(flags, "mcpHealthStdioProbe", false));
  try {
    const { mcpServers } = await getUserConfig();
    const configured = mcpServers.servers;
    if (configured.length > 0) mcpHealthCache.enqueue(configured);
    return configured;
  } catch {
    return [];
  }
}
