import { NextRequest, NextResponse } from "next/server";
import { scanClaudePlans } from "@/lib/scanner/claudePlans";
import type { PlanEntry } from "@/lib/types";
import { getOrCreateRouteCache } from "@/lib/routeCache";

const CACHE_TTL_MS = 2 * 60 * 1000;
const PLANS_CACHE_KEY = "all";

const cache = getOrCreateRouteCache<PlanEntry[]>("plans", { ttlMs: CACHE_TTL_MS, maxEntries: 1 });

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? undefined;
  const tag = request.nextUrl.searchParams.get("tag") ?? undefined;
  const sessionId = request.nextUrl.searchParams.get("session") ?? undefined;

  let plans = cache.get(PLANS_CACHE_KEY) ?? null;
  if (!plans) {
    plans = await scanClaudePlans();
    if (!q && !tag && !sessionId) {
      cache.set(PLANS_CACHE_KEY, plans);
    }
  }

  if (q) {
    plans = plans.filter((p) =>
      [p.title, p.slug, ...p.tags].join(" ").toLowerCase().includes(q)
    );
  }
  if (tag) {
    plans = plans.filter((p) => p.tags.includes(tag));
  }
  if (sessionId) {
    plans = plans.filter((p) => p.relatedSessionIds.includes(sessionId.toLowerCase()));
  }

  return NextResponse.json(plans);
}
