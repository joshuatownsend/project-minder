import { NextRequest } from "next/server";
import { generateUsageReport } from "@/lib/usage/aggregator";
import { validatePeriod } from "@/lib/usage/constants";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import type { UsageReport } from "@/lib/usage/types";

const CACHE_TTL = 2 * 60_000;

interface UsageCacheSlot {
  report: UsageReport;
  cachedAt: number;
  // Snapshot of `getJsonlMaxMtime()` at report-generation time. Used as the
  // ETag input so the ETag describes the bytes we're about to serve, not the
  // current filesystem state — otherwise a JSONL change inside the cache TTL
  // window would rotate the ETag while the served bytes stayed identical.
  maxMtime: number;
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

  const cacheKey = `${safePeriod}:${project || "all"}`;
  const cache = globalForUsage.__usageCache!;
  const cached = cache.get(cacheKey);
  const fresh = cached && Date.now() - cached.cachedAt < CACHE_TTL;

  let slot: UsageCacheSlot;
  if (fresh) {
    slot = cached!;
  } else {
    const report = await generateUsageReport(safePeriod, project);
    // Capture max mtime AFTER generateUsageReport — it calls parseAllSessions
    // which populates the FileCache, so getJsonlMaxMtime() now reflects every
    // input file we read for this report.
    slot = { report, cachedAt: Date.now(), maxMtime: getJsonlMaxMtime() };
    cache.set(cacheKey, slot);
  }

  const etag = computeETag({
    salt: "usage-v1",
    maxMtimeMs: slot.maxMtime,
    parts: [safePeriod, project ?? ""],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  return jsonWithETag(slot.report, etag);
}
