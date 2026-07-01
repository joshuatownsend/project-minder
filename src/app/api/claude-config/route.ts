import { NextRequest, NextResponse } from "next/server";
import { CONFIG_TYPES, ConfigType } from "@/lib/types";
import type { ConfigPayload } from "@/hooks/useConfig";
import { loadClaudeConfigResponse } from "@/lib/server/queries/config";

// Response assembly lives in `@/lib/server/queries/config` so the RSC prefetch
// (PR 3) produces a byte-identical body. This route keeps the per-(type,project)
// 2-min response cache that fronts that computation for repeat dashboard loads.

const CACHE_TTL_MS = 2 * 60 * 1000;

const globalForCC = globalThis as unknown as {
  __claudeConfigCache?: Map<string, { data: ConfigPayload; cachedAt: number }>;
};

function getRouteCache(key: string): ConfigPayload | null {
  const cache = globalForCC.__claudeConfigCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  cache.delete(key);
  return null;
}

function setRouteCache(key: string, data: ConfigPayload) {
  let cache = globalForCC.__claudeConfigCache;
  if (!cache) {
    cache = new Map();
    globalForCC.__claudeConfigCache = cache;
  }
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, slot] of cache) {
    if (slot.cachedAt < cutoff) cache.delete(k);
  }
  cache.set(key, { data, cachedAt: Date.now() });
}

export function invalidateClaudeConfigRouteCache() {
  globalForCC.__claudeConfigCache = new Map();
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

  const payload = await loadClaudeConfigResponse(type, projectSlug ?? null, query ?? null);

  if (cacheable) {
    setRouteCache(cacheKey, payload);
  }
  return NextResponse.json(payload);
}
