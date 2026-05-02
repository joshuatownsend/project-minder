import { NextResponse } from "next/server";
import { encodePath } from "@/lib/scanner/claudeConversations";
import { getSessionsList, type SessionsListResult } from "@/lib/data";
import { readConfig, getDevRoots } from "@/lib/config";

const CACHE_TTL = 30_000;

// Shared globalThis cache slot with /api/sessions — both routes consume the
// same SessionSummary[] so a single refresh serves both endpoints.
const globalForSessions = globalThis as unknown as {
  __sessionsCache?: { result: SessionsListResult; cachedAt: number; maxSessionMs: number };
};

// Returns Record<projectSlug, number[]> — 14 daily session counts, UTC, oldest→newest
export async function GET() {
  let cache = globalForSessions.__sessionsCache;
  if (!cache || Date.now() - cache.cachedAt > CACHE_TTL) {
    const result = await getSessionsList();
    // Match /api/sessions/route.ts's slot shape exactly so the two routes
    // share the cache cleanly. `maxSessionMs` is unused here but kept so
    // a refresh from this route still satisfies the other route's ETag
    // inputs without recomputing.
    let max = 0;
    for (const s of result.sessions) {
      const ts = s.endTime ?? s.startTime;
      if (!ts) continue;
      const ms = new Date(ts).getTime();
      if (Number.isFinite(ms) && ms > max) max = ms;
    }
    cache = { result, cachedAt: Date.now(), maxSessionMs: max };
    globalForSessions.__sessionsCache = cache;
  }

  const config = await readConfig();
  const roots = getDevRoots(config);
  // Re-encoding devRoots gives Claude directory prefixes. decodeDirName is lossy
  // for hyphenated project names, so we re-encode session.projectPath to recover
  // the original Claude directory name, then strip the devRoot prefix.
  // Normalize trailing slashes before encoding; sort longest-first so a more-specific
  // root (e.g. /dev/projects) can't be shadowed by a shorter one (/dev)
  const encodedPrefixes = roots
    .map((r) => encodePath(r.replace(/[\\/]+$/, "")) + "-")
    .sort((a, b) => b.length - a.length);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (13 - i));
    return d.getTime();
  });

  const result: Record<string, number[]> = {};

  for (const session of cache.result.sessions) {
    const reEncoded = encodePath(session.projectPath);
    const prefix = encodedPrefixes.find((p) => reEncoded.startsWith(p));
    if (!prefix) continue;
    const slug = reEncoded.slice(prefix.length).toLowerCase().replace(/[^a-z0-9-]/g, "-");

    if (!result[slug]) result[slug] = new Array(14).fill(0);

    const ts = session.startTime ? new Date(session.startTime).getTime() : null;
    if (!ts) continue;

    const dayStart = new Date(ts);
    dayStart.setUTCHours(0, 0, 0, 0);
    const idx = days.findIndex((d) => d === dayStart.getTime());
    if (idx !== -1) result[slug][idx]++;
  }

  const response = NextResponse.json(result);
  response.headers.set("X-Minder-Backend", cache.result.meta.backend);
  return response;
}
