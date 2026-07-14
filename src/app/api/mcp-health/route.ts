import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getUserConfig } from "@/lib/userConfigCache";
import { mcpHealthCache, serverIdentity } from "@/lib/mcpHealthCache";
import { mcpConfigWatcher } from "@/lib/mcpConfigWatcher";
import type { McpHealth } from "@/lib/types";

/**
 * GET /api/mcp-health — live health of user-scope MCP servers.
 *
 * Unlike the git/github caches (enqueued at the /api/projects load site), the
 * MCP strip is a single global surface with no per-project fan-out, so this
 * route both gates AND enqueues: read the flag, pull the user-scope server list
 * from ~/.claude.json, enqueue any stale entries, then return whatever the
 * cache has (probes run in the background). First poll returns `servers: {}`
 * while probes are in flight; the client polls faster while `pending > 0`.
 */
export async function GET() {
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "mcpHealth")) {
    return NextResponse.json({ enabled: false, servers: {}, pending: 0, total: 0 });
  }

  // Watch the user-scope MCP config files so an externally-removed server drops
  // from the strip immediately instead of at the 5-min config-cache TTL.
  // Idempotent; only invalidates the cache when the mcpServers slice changes.
  mcpConfigWatcher.ensureStarted();

  const configuredIds = new Set<string>();
  try {
    // The full user-scope MCP surface — the same merged reader the rest of the
    // app uses (managed policy + ~/.claude/settings.json + ~/.claude.json +
    // Claude Desktop + plugins), not just the ~/.claude.json slice, so no
    // configured server is silently missing from the strip.
    const { mcpServers } = await getUserConfig();
    const configured = mcpServers.servers;
    for (const s of configured) configuredIds.add(serverIdentity(s));
    if (configured.length > 0) mcpHealthCache.enqueue(configured);
  } catch {
    // Defensive: a missing/broken config source must never blank the strip.
  }

  // Filter cached health to the CURRENTLY-configured servers (by identity, so
  // two same-name servers from different sources are both kept). The cache
  // holds entries for the full TTL, so a server removed from config (or an
  // emptied list) would otherwise linger on the strip — with a stale count —
  // until its 5-min entry expires. Filtering here drops it immediately.
  const all = mcpHealthCache.getAll();
  const servers: Record<string, McpHealth> = {};
  for (const [id, health] of Object.entries(all)) {
    if (configuredIds.has(id)) servers[id] = health;
  }

  return NextResponse.json({
    enabled: true,
    servers,
    pending: mcpHealthCache.pending,
    total: configuredIds.size,
  });
}
