import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getToolLatency } from "@/lib/db/otelQueries";

// GET /api/telemetry/tool-latency?since=ISO&sessionId=
// Returns per-tool p50/p95/max latency and error rates for ToolLatencyCard.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const sinceParam = searchParams.get("since");
  const sessionId  = searchParams.get("sessionId") ?? undefined;
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  const result = await getToolLatency({ since, sessionId });
  return NextResponse.json(result);
}
