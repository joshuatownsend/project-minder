import { NextRequest, NextResponse } from "next/server";
import { getSessionsList } from "@/lib/data";
import { getFacetsAggregate } from "@/lib/scanner/claudeFacets";
import { validatePeriod } from "@/lib/usage/constants";
import { getPeriodStart } from "@/lib/usage/periods";

interface FeedbackCacheSlot {
  data: object;
  cachedAt: number;
  key: string;
}

const globalForFeedback = globalThis as unknown as {
  __feedbackCache?: FeedbackCacheSlot;
};

const CACHE_TTL = 2 * 60_000;

// `GET /api/feedback?period=month&project=slug` — cross-session aggregate of
// Claude qualitative feedback (facets). Reads the session list filtered by
// period/project, then aggregates all available facets files.
//
// Cached for 2 minutes (same TTL as /api/usage) — facets files are written
// once per session and rarely change.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const period = validatePeriod(params.get("period") ?? "month");
  const projectSlug = params.get("project") ?? null;
  const cacheKey = `${period}|${projectSlug ?? ""}`;

  const slot = globalForFeedback.__feedbackCache;
  if (slot && slot.key === cacheKey && Date.now() - slot.cachedAt < CACHE_TTL) {
    return NextResponse.json(slot.data);
  }

  const { sessions } = await getSessionsList();

  const periodStart = getPeriodStart(period);
  const filtered = sessions.filter((s) => {
    if (projectSlug && s.projectSlug !== projectSlug) return false;
    if (periodStart) {
      const ts = s.endTime ?? s.startTime;
      if (!ts || new Date(ts) < periodStart) return false;
    }
    return true;
  });

  const sessionIds = filtered.map((s) => s.sessionId);
  const aggregate = await getFacetsAggregate(sessionIds);

  const result = { period, projectSlug, ...aggregate };
  globalForFeedback.__feedbackCache = { data: result, cachedAt: Date.now(), key: cacheKey };

  return NextResponse.json(result);
}
