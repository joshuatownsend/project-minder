import { NextRequest, NextResponse } from "next/server";
import { buildAgentNetwork, type NetworkReport } from "@/lib/usage/agentNetwork";
import { findSessionFile, parseSessionTurns } from "@/lib/usage/parser";
import { getOrCreateRouteCache } from "@/lib/routeCache";

const cache = getOrCreateRouteCache<NetworkReport>("agent-network", { ttlMs: 60_000 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const cached = cache.get(sessionId);
  if (cached) return NextResponse.json(cached);

  const found = await findSessionFile(sessionId);
  if (!found) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const turns = await parseSessionTurns(found.filePath, found.projectDirName, { includeSidechains: true });
  const report = buildAgentNetwork(turns);

  cache.set(sessionId, report);
  return NextResponse.json(report);
}
