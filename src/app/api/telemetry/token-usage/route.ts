import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getTokenUsage } from "@/lib/db/otelQueries";

// GET /api/telemetry/token-usage?period=today|7d|30d
// Returns daily token breakdown (input/output/cacheRead/cacheCreation) and totals.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const period = (searchParams.get("period") ?? "7d") as "today" | "7d" | "30d";

  if (!["today", "7d", "30d"].includes(period)) {
    return NextResponse.json({ error: "period must be today|7d|30d" }, { status: 400 });
  }

  const result = await getTokenUsage({ period });
  return NextResponse.json(result);
}
