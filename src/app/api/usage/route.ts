import { NextRequest } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getUsage, dbModeRequested } from "@/lib/data";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import type { UsageReport } from "@/lib/usage/types";

const CACHE_TTL = 2 * 60_000;

interface UsageCacheSlot {
  report: UsageReport;
  cachedAt: number;
  // Snapshot of the input-mtime signal at report-generation time. For the
  // file-parse backend this is `getJsonlMaxMtime()`; for the DB backend it's
  // `MAX(file_mtime_ms) FROM sessions`. Used as the ETag input so the ETag
  // describes the bytes we're about to serve, not the current state — a
  // change inside the cache TTL window would otherwise rotate the ETag while
  // the served bytes stayed identical.
  maxMtime: number;
  backend: "db" | "file";
}

const globalForUsage = globalThis as unknown as {
  __usageCache?: Map<string, UsageCacheSlot>;
};

if (!globalForUsage.__usageCache) {
  globalForUsage.__usageCache = new Map();
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const safePeriod = validatePeriod(params.get("period") || "month");
  const project = params.get("project") || undefined;

  // Include the requested backend in the cache key so a flag flip
  // (MINDER_USE_DB toggled at runtime) invalidates the slot immediately
  // — without this, a cached file-backend report could be served to a
  // db-backend caller for the rest of the 2-min TTL window.
  const requestedBackend = dbModeRequested() ? "db" : "file";
  const cacheKey = `${requestedBackend}:${safePeriod}:${project || "all"}`;
  const cache = globalForUsage.__usageCache!;
  const cached = cache.get(cacheKey);
  const fresh = cached && Date.now() - cached.cachedAt < CACHE_TTL;

  let slot: UsageCacheSlot;
  if (fresh) {
    slot = cached!;
  } else {
    const { report, meta } = await getUsage(safePeriod, project);
    slot = {
      report,
      cachedAt: Date.now(),
      maxMtime: meta.maxMtimeMs,
      backend: meta.backend,
    };
    cache.set(cacheKey, slot);
  }

  // Salt the ETag with the backend so a runtime flag flip (e.g. operator
  // toggles MINDER_USE_DB between server starts) invalidates client caches
  // — backends could differ on edge cases until the schema is fully aligned.
  const etag = computeETag({
    salt: `usage-v2-${slot.backend}`,
    maxMtimeMs: slot.maxMtime,
    parts: [safePeriod, project ?? ""],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) {
    notModified.headers.set("X-Minder-Backend", slot.backend);
    return notModified;
  }

  const response = jsonWithETag(slot.report, etag);
  response.headers.set("X-Minder-Backend", slot.backend);
  return response;
}
