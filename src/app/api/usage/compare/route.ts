import { NextRequest } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getUsageCompare, dbModeRequested } from "@/lib/data";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import type { UsageComparison } from "@/lib/usage/types";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { demoMode } from "@/lib/demo/demoMode";
import { normalizePathKey } from "@/lib/platform";

// Period-over-period comparison for /usage (item 4a). Mirrors the
// /api/usage route's 2-minute slot cache: the comparison runs four
// turn-aggregate queries plus two distinct-session scans (the latter aren't
// index-covered — `turns(role, ts)` can't serve the role-less session count),
// so caching keeps a polling client off repeated table scans. The cached
// comparison reflects the window as of `cachedAt` (up to the TTL stale) —
// the same staleness profile the usage report cache already accepts.
//
// Client-side 304s ride an ETag salted by mtime AND the cache-slot timestamp.
// The slot timestamp is essential here, not redundant: a rolling window's
// payload changes as `now` advances even when no file changes — turns age out
// of the trailing edge, and `today` flips at midnight. An mtime-only ETag
// would let a client revalidate with a stale `If-None-Match` and get a 304
// against a freshly-recomputed comparison, pinning the UI to the old windows
// until some unrelated file changed. Keying on `cachedAt` rotates the ETag
// exactly when the server recomputes the slot, bounding client staleness to
// the same TTL the server already accepts.

const CACHE_TTL = 2 * 60_000;

interface CompareCacheSlot {
  comparison: UsageComparison;
  cachedAt: number;
  maxMtime: number;
  backend: "db" | "file";
}

const cache = getOrCreateRouteCache<CompareCacheSlot>("usage-compare", { ttlMs: CACHE_TTL });

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const safePeriod = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const source = params.get("source") || undefined;
  // Claude-home discriminator (#311) — see the /api/usage route.
  const rawHome = params.get("home") || undefined;
  const home = rawHome ? normalizePathKey(rawHome) : undefined;

  const requestedBackend = dbModeRequested() ? "db" : "file";
  // Salt with demo state so toggling the in-app `demoMode` flag invalidates the
  // slot immediately (see the /api/usage route for the rationale).
  const demo = (await demoMode()) ? "demo:" : "";
  const cacheKey = `${demo}${requestedBackend}:${safePeriod}:${project || "all"}:${source || "all"}:${home || "all"}`;
  const cached = cache.get(cacheKey);

  let slot: CompareCacheSlot;
  if (cached) {
    slot = cached;
  } else {
    const { comparison, meta } = await getUsageCompare(safePeriod, project, source, home);
    slot = { comparison, cachedAt: Date.now(), maxMtime: meta.maxMtimeMs, backend: meta.backend };
    cache.set(cacheKey, slot);
  }

  const etag = computeETag({
    salt: `usage-compare-v1-${slot.backend}${demo ? "-demo" : ""}`,
    maxMtimeMs: slot.maxMtime,
    parts: [safePeriod, project ?? "", source ?? "", home ?? "", String(slot.cachedAt)],
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
