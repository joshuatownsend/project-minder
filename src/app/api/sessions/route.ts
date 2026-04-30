import { NextRequest } from "next/server";
import { scanAllSessions } from "@/lib/scanner/claudeConversations";
import { SessionSummary } from "@/lib/types";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";

const CACHE_TTL = 30_000; // 30s — kept short so live status badges on the dashboard are timely

// globalThis singleton — survives Next.js module reloads
const globalForSessions = globalThis as unknown as {
  __sessionsCache?: { sessions: SessionSummary[]; cachedAt: number };
};

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");

  // Refresh the in-route cache when stale. scanAllSessions itself is mtime-cached
  // via claudeStatsCache on disk, so a refresh that finds no JSONL changes is
  // already cheap — we just don't want to re-do the per-call work.
  let cache = globalForSessions.__sessionsCache;
  if (!cache || Date.now() - cache.cachedAt > CACHE_TTL) {
    const sessions = await scanAllSessions();
    cache = { sessions, cachedAt: Date.now() };
    globalForSessions.__sessionsCache = cache;
  }

  // ETag uses the cache's `cachedAt` as the freshness signal — it rotates
  // every CACHE_TTL window. Within a window, all repeat calls match the same
  // ETag and return 304. We don't need to stat individual JSONL files here
  // because scanAllSessions already does that internally and only produces a
  // new SessionSummary[] when something changed.
  const etag = computeETag({
    salt: "sessions-v1",
    maxMtimeMs: cache.cachedAt,
    parts: [project ?? "", cache.sessions.length],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  let results = cache.sessions;
  if (project) {
    results = results.filter((s) => s.projectSlug === project || s.projectName.includes(project));
  }

  return jsonWithETag(results, etag);
}
