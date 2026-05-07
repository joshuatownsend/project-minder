import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getPressureSnapshot } from "@/lib/db/otelQueries";

// GET /api/telemetry/pressure?since=ISO
// Returns API error, retry exhaustion, and compaction counts + last 10 errors.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const sinceParam = searchParams.get("since");
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  const result = await getPressureSnapshot({ since });
  return NextResponse.json(result);
}
