import { NextRequest, NextResponse } from "next/server";
import { loadOrchestrationGraph } from "@/lib/usage/orchestrationGraph";
import type { OrchestrationGraph } from "@/lib/usage/orchestrationGraph";

const globalForOrch = globalThis as unknown as {
  __orchestrationCache?: Map<string, { graph: OrchestrationGraph; expiresAt: number }>;
};

function getCache() {
  if (!globalForOrch.__orchestrationCache) {
    globalForOrch.__orchestrationCache = new Map();
  }
  return globalForOrch.__orchestrationCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const now = Date.now();
  const cache = getCache();
  const cached = cache.get(sessionId);
  if (cached && now < cached.expiresAt) {
    return NextResponse.json(cached.graph);
  }

  const graph = await loadOrchestrationGraph(sessionId);
  if (graph === null) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  cache.set(sessionId, { graph, expiresAt: now + 60_000 });
  return NextResponse.json(graph);
}
