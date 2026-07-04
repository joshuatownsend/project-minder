import { NextRequest, NextResponse } from "next/server";
import { buildModelDelegation, type DelegationReport } from "@/lib/usage/modelDelegation";
import { findSessionFile, parseSessionTurns } from "@/lib/usage/parser";
import { getOrCreateRouteCache } from "@/lib/routeCache";

const cache = getOrCreateRouteCache<DelegationReport>("model-delegation", { ttlMs: 60_000 });

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
  const report = buildModelDelegation(turns);

  cache.set(sessionId, report);
  return NextResponse.json(report);
}
