import { NextRequest, NextResponse } from "next/server";
import { loadOrchestrationGraph } from "@/lib/usage/orchestrationGraph";
import type { OrchestrationGraph } from "@/lib/usage/orchestrationGraph";
import { getOrCreateRouteCache } from "@/lib/routeCache";

const cache = getOrCreateRouteCache<OrchestrationGraph>("orchestration", { ttlMs: 60_000 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const cached = cache.get(sessionId);
  if (cached) return NextResponse.json(cached);

  const graph = await loadOrchestrationGraph(sessionId);
  if (graph === null) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  cache.set(sessionId, graph);
  return NextResponse.json(graph);
}
