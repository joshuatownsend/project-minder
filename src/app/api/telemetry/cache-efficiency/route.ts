import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCacheEfficiency } from "@/lib/db/otelQueries";
import { resolveSinceParam } from "@/lib/telemetryPeriod";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  // Prefers `since`, falls back to `period` — see the token-usage route.
  const { since, error } = resolveSinceParam(searchParams);
  if (error !== undefined) {
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    const result = await getCacheEfficiency({ since });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/cache-efficiency]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
