import { NextRequest, NextResponse } from "next/server";
import { buildConcurrencyTimeline, type TimelineReport } from "@/lib/usage/concurrencyTimeline";
import { findSessionFile, parseSessionTurns } from "@/lib/usage/parser";

const globalForConcurrency = globalThis as unknown as {
  __concurrencyCache?: Map<string, { report: TimelineReport; expiresAt: number }>;
};

function getCache() {
  if (!globalForConcurrency.__concurrencyCache) {
    globalForConcurrency.__concurrencyCache = new Map();
  }
  return globalForConcurrency.__concurrencyCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const now = Date.now();
  const cache = getCache();
  const cached = cache.get(sessionId);
  if (cached && now < cached.expiresAt) return NextResponse.json(cached.report);

  const found = await findSessionFile(sessionId);
  if (!found) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const turns = await parseSessionTurns(found.filePath, found.projectDirName, { includeSidechains: true });
  const report = buildConcurrencyTimeline(turns);

  cache.set(sessionId, { report, expiresAt: now + 60_000 });
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  return NextResponse.json(report);
}
