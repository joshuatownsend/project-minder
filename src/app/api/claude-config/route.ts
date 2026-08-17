import { NextRequest, NextResponse } from "next/server";
import { CONFIG_TYPES, ConfigType } from "@/lib/types";
import type { ConfigPayload } from "@/hooks/useConfig";
import { loadClaudeConfigResponse } from "@/lib/server/queries/config";
import { getOrCreateRouteCache } from "@/lib/routeCache";

// Response assembly lives in `@/lib/server/queries/config` so the RSC prefetch
// (PR 3) produces a byte-identical body. This route keeps the per-(type,project)
// 2-min response cache that fronts that computation for repeat dashboard loads.

const CACHE_TTL_MS = 2 * 60 * 1000;

const cache = getOrCreateRouteCache<ConfigPayload>("claude-config", { ttlMs: CACHE_TTL_MS });

function getRouteCache(key: string): ConfigPayload | null {
  return cache.get(key) ?? null;
}

export function invalidateClaudeConfigRouteCache() {
  cache.clear();
}

export async function GET(request: NextRequest) {
  const typeParam = (request.nextUrl.searchParams.get("type") ?? "all").toLowerCase();
  const type: ConfigType = (CONFIG_TYPES as readonly string[]).includes(typeParam)
    ? (typeParam as ConfigType)
    : "all";
  const projectSlug = request.nextUrl.searchParams.get("project") ?? undefined;
  const query = request.nextUrl.searchParams.get("q") ?? undefined;

  const cacheable = !query;
  const cacheKey = `${type}|${projectSlug ?? ""}`;
  if (cacheable) {
    const cached = getRouteCache(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  // `getOrLoad` rather than load-then-set: `loadClaudeConfigResponse` reaches
  // the demo-guarded `getUserConfig()`, so a write racing a config-write
  // dispose could put real hook commands and MCP servers back under this
  // mode-agnostic key. See TtlCache.getOrLoad.
  const load = () => loadClaudeConfigResponse(type, projectSlug ?? null, query ?? null);
  const payload = cacheable ? await cache.getOrLoad(cacheKey, load) : await load();

  return NextResponse.json(payload);
}
