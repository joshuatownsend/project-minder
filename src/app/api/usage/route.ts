import { NextRequest, NextResponse } from "next/server";
import { generateUsageReport } from "@/lib/usage/aggregator";
import type { UsageReport } from "@/lib/usage/types";

const CACHE_TTL = 2 * 60_000; // 2 minutes

const globalForUsage = globalThis as unknown as {
  __usageCache?: Map<string, { report: UsageReport; cachedAt: number }>;
};

if (!globalForUsage.__usageCache) {
  globalForUsage.__usageCache = new Map();
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const period = params.get("period") || "month";
  const project = params.get("project") || undefined;

  // Validate period
  const validPeriods = ["today", "week", "month", "all"];
  const safePeriod = validPeriods.includes(period)
    ? (period as "today" | "week" | "month" | "all")
    : "month";

  const cacheKey = `${safePeriod}:${project || "all"}`;
  const cache = globalForUsage.__usageCache!;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return NextResponse.json(cached.report);
  }

  const report = await generateUsageReport(safePeriod, project);
  cache.set(cacheKey, { report, cachedAt: Date.now() });

  return NextResponse.json(report);
}
