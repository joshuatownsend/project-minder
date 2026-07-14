import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { readUserScopeMcpFromClaudeJson } from "@/lib/scanner/claudeJsonMcp";
import { mcpHealthCache } from "@/lib/mcpHealthCache";

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

  try {
    const servers = await readUserScopeMcpFromClaudeJson();
    if (servers.length > 0) mcpHealthCache.enqueue(servers);
  } catch {
    // Defensive: a missing/broken ~/.claude.json must never blank the strip.
  }

  return NextResponse.json({
    enabled: true,
    servers: mcpHealthCache.getAll(), // Record<name, McpHealth>
    pending: mcpHealthCache.pending,
    total: mcpHealthCache.total,
  });
}
