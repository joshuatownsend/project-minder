import { NextRequest } from "next/server";
import { scanAllSessions } from "@/lib/scanner/claudeConversations";
import { SessionSummary } from "@/lib/types";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";

const CACHE_TTL = 30_000; // 30s — kept short so live status badges on the dashboard are timely

interface SessionsCacheSlot {
  sessions: SessionSummary[];
  cachedAt: number;
  // Content-derived watermark: max(endTime, startTime) across the cached
  // session set. Captured at refresh time and used as the ETag input so the
  // ETag only rotates when the underlying session content actually changed,
  // not on every CACHE_TTL boundary. Matches the semantics already in place
  // for /api/usage and /api/stats.
  maxSessionMs: number;
}

// globalThis singleton — survives Next.js module reloads
const globalForSessions = globalThis as unknown as {
  __sessionsCache?: SessionsCacheSlot;
};

function deriveMaxSessionMs(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const ts = s.endTime ?? s.startTime;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");

  // Refresh the in-route cache when stale. scanAllSessions itself is mtime-cached
  // via claudeStatsCache on disk, so a refresh that finds no JSONL changes is
  // already cheap — we just don't want to re-do the per-call work.
  let cache = globalForSessions.__sessionsCache;
  if (!cache || Date.now() - cache.cachedAt > CACHE_TTL) {
    const sessions = await scanAllSessions();
    cache = {
      sessions,
      cachedAt: Date.now(),
      maxSessionMs: deriveMaxSessionMs(sessions),
    };
    globalForSessions.__sessionsCache = cache;
  }

  const etag = computeETag({
    salt: "sessions-v1",
    maxMtimeMs: cache.maxSessionMs,
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
