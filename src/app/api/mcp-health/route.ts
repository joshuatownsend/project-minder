import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { readUserScopeMcpFromClaudeJson } from "@/lib/scanner/claudeJsonMcp";
import { mcpHealthCache } from "@/lib/mcpHealthCache";
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

  const configuredNames = new Set<string>();
  try {
    const configured = await readUserScopeMcpFromClaudeJson();
    for (const s of configured) configuredNames.add(s.name);
    if (configured.length > 0) mcpHealthCache.enqueue(configured);
  } catch {
    // Defensive: a missing/broken ~/.claude.json must never blank the strip.
  }

  // Filter cached health to the CURRENTLY-configured servers. The cache is
  // keyed by name and holds entries for the full TTL, so a server removed from
  // ~/.claude.json (or an emptied list) would otherwise linger on the strip —
  // with a stale count — until its 5-min entry expires. Filtering here drops it
  // immediately.
  const all = mcpHealthCache.getAll();
  const servers: Record<string, McpHealth> = {};
  for (const [name, health] of Object.entries(all)) {
    if (configuredNames.has(name)) servers[name] = health;
  }

  return NextResponse.json({
    enabled: true,
    servers,
    pending: mcpHealthCache.pending,
    total: configuredNames.size,
  });
}
