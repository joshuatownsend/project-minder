import { NextRequest } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getUsageCompare, dbModeRequested } from "@/lib/data";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import type { UsageComparison } from "@/lib/usage/types";

// Period-over-period comparison for /usage (item 4a). Mirrors the
// /api/usage route's 2-minute slot cache: the comparison runs four
// turn-aggregate queries plus two distinct-session scans (the latter aren't
// index-covered — `turns(role, ts)` can't serve the role-less session count),
// so caching keeps a polling client off repeated table scans. The cached
// comparison reflects the window as of `cachedAt` (up to the TTL stale) —
// the same staleness profile the usage report cache already accepts.
//
// Client-side 304s ride an mtime-salted ETag: identical underlying data (same
// `MAX(file_mtime_ms)`) yields the same ETag even as the window edges drift by
// seconds, because no new turns fall into the shifted edges.

const CACHE_TTL = 2 * 60_000;

interface CompareCacheSlot {
  comparison: UsageComparison;
  cachedAt: number;
  maxMtime: number;
  backend: "db" | "file";
}

const globalForCompare = globalThis as unknown as {
  __usageCompareCache?: Map<string, CompareCacheSlot>;
};
globalForCompare.__usageCompareCache ??= new Map();

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const safePeriod = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const source = params.get("source") || undefined;

  const requestedBackend = dbModeRequested() ? "db" : "file";
  const cacheKey = `${requestedBackend}:${safePeriod}:${project || "all"}:${source || "all"}`;
  const cache = globalForCompare.__usageCompareCache!;
  const cached = cache.get(cacheKey);

  let slot: CompareCacheSlot;
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    slot = cached;
  } else {
    const { comparison, meta } = await getUsageCompare(safePeriod, project, source);
    slot = { comparison, cachedAt: Date.now(), maxMtime: meta.maxMtimeMs, backend: meta.backend };
    cache.set(cacheKey, slot);
  }

  const etag = computeETag({
    salt: `usage-compare-v1-${slot.backend}`,
    maxMtimeMs: slot.maxMtime,
    parts: [safePeriod, project ?? "", source ?? ""],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) {
    notModified.headers.set("X-Minder-Backend", slot.backend);
    return notModified;
  }

  const response = jsonWithETag(slot.comparison, etag);
  response.headers.set("X-Minder-Backend", slot.backend);
  return response;
}
