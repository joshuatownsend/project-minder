import { NextResponse } from "next/server";
import { scanAllSessions, encodePath } from "@/lib/scanner/claudeConversations";
import { readConfig, getDevRoots } from "@/lib/config";
import { SessionSummary } from "@/lib/types";

const CACHE_TTL = 30_000;

const globalForSessions = globalThis as unknown as {
  __sessionsCache?: { sessions: SessionSummary[]; cachedAt: number };
};

// Returns Record<projectSlug, number[]> — 14 daily session counts, UTC, oldest→newest
export async function GET() {
  let cache = globalForSessions.__sessionsCache;
  if (!cache || Date.now() - cache.cachedAt > CACHE_TTL) {
    const sessions = await scanAllSessions();
    cache = { sessions, cachedAt: Date.now() };
    globalForSessions.__sessionsCache = cache;
  }

  const config = await readConfig();
  const roots = getDevRoots(config);
  // Re-encoding devRoots gives Claude directory prefixes. decodeDirName is lossy
  // for hyphenated project names, so we re-encode session.projectPath to recover
  // the original Claude directory name, then strip the devRoot prefix.
  const encodedPrefixes = roots.map((r) => encodePath(r) + "-");

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (13 - i));
    return d.getTime();
  });

  const result: Record<string, number[]> = {};

  for (const session of cache.sessions) {
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

  return NextResponse.json(result);
}
