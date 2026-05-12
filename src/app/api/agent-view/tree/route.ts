import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { loadOrchestrationGraph } from "@/lib/usage/orchestrationGraph";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  try {
    const graph = await loadOrchestrationGraph(sessionId);
    return NextResponse.json({ graph: graph ?? null });
  } catch {
    return NextResponse.json({ graph: null });
  }
}
