import { NextRequest, NextResponse } from "next/server";
import { buildAgentNetwork, type NetworkReport } from "@/lib/usage/agentNetwork";
import { findSessionFile, parseSessionTurns } from "@/lib/usage/parser";

const globalForNetwork = globalThis as unknown as {
  __agentNetworkCache?: Map<string, { report: NetworkReport; expiresAt: number }>;
};

function getCache() {
  if (!globalForNetwork.__agentNetworkCache) {
    globalForNetwork.__agentNetworkCache = new Map();
  }
  return globalForNetwork.__agentNetworkCache;
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
  const report = buildAgentNetwork(turns);

  cache.set(sessionId, { report, expiresAt: now + 60_000 });
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  return NextResponse.json(report);
}
