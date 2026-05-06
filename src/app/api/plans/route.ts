import { NextRequest, NextResponse } from "next/server";
import { scanClaudePlans } from "@/lib/scanner/claudePlans";
import type { PlanEntry } from "@/lib/types";

const CACHE_TTL_MS = 2 * 60 * 1000;

const g = globalThis as unknown as {
  __plansCache?: { data: PlanEntry[]; cachedAt: number } | null;
};

function getCache(): PlanEntry[] | null {
  const slot = g.__plansCache;
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  g.__plansCache = null;
  return null;
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? undefined;
  const tag = request.nextUrl.searchParams.get("tag") ?? undefined;
  const sessionId = request.nextUrl.searchParams.get("session") ?? undefined;

  let plans = getCache();
  if (!plans) {
    plans = await scanClaudePlans();
    if (!q && !tag && !sessionId) {
      g.__plansCache = { data: plans, cachedAt: Date.now() };
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
