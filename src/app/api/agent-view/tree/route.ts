import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { loadOrchestrationGraph } from "@/lib/usage/orchestrationGraph";
import { isValidSessionId } from "@/lib/usage/parser";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }

  try {
    const graph = await loadOrchestrationGraph(sessionId);
    return NextResponse.json({ graph: graph ?? null });
  } catch {
    return NextResponse.json({ error: "failed to load graph" }, { status: 500 });
  }
}
