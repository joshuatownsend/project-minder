import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getHookActivity } from "@/lib/db/otelQueries";

// GET /api/telemetry/hook-activity?since=ISO
// Returns per-hook fire counts and p50/p95 duration for HookActivityCard.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const sinceParam = searchParams.get("since");
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  const result = await getHookActivity({ since });
  return NextResponse.json(result);
}
