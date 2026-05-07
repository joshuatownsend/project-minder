import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCacheEfficiency } from "@/lib/db/otelQueries";

// GET /api/telemetry/cache-efficiency?period=today|7d|30d
// Returns overall hit rate, daily sparkline, and total billable token count.
// hit rate = cacheRead / (input + output + cacheCreation)
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const period = (searchParams.get("period") ?? "7d") as "today" | "7d" | "30d";

  if (!["today", "7d", "30d"].includes(period)) {
    return NextResponse.json({ error: "period must be today|7d|30d" }, { status: 400 });
  }

  const result = await getCacheEfficiency({ period });
  return NextResponse.json(result);
}
