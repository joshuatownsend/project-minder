import { NextRequest, NextResponse } from "next/server";
import { scanAllSessions } from "@/lib/scanner/claudeConversations";
import { SessionSummary } from "@/lib/types";

const CACHE_TTL = 30_000; // 30s — kept short so live status badges on the dashboard are timely

// globalThis singleton — survives Next.js module reloads
const globalForSessions = globalThis as unknown as {
  __sessionsCache?: { sessions: SessionSummary[]; cachedAt: number };
};

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");

  let cache = globalForSessions.__sessionsCache;
  if (!cache || Date.now() - cache.cachedAt > CACHE_TTL) {
    const sessions = await scanAllSessions();
    cache = { sessions, cachedAt: Date.now() };
    globalForSessions.__sessionsCache = cache;
  }

  let results = cache.sessions;
  if (project) {
    results = results.filter((s) => s.projectSlug === project || s.projectName.includes(project));
  }

  return NextResponse.json(results);
}
